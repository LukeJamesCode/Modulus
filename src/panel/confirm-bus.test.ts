import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ToolContext, ToolHandler } from '../core/tools.js';
import { createPanelConfirmBus } from './confirm-bus.js';

const handler = { name: 'rm' } as unknown as ToolHandler;
const ctxFor = (chatId: number | undefined): ToolContext => ({ chatId }) as unknown as ToolContext;

test('confirm bus routes to a registered renderer, by chatId', async () => {
  const bus = createPanelConfirmBus();
  // No renderer → null so the daemon router falls through to its other surfaces.
  assert.equal(bus.tryConfirm(handler, {}, ctxFor(7)), null);

  const fn = async (): Promise<boolean> => true;
  bus.register(7, fn);
  const pending = bus.tryConfirm(handler, {}, ctxFor(7));
  assert.ok(pending instanceof Promise);
  assert.equal(await pending, true);

  // A different chat has no renderer.
  assert.equal(bus.tryConfirm(handler, {}, ctxFor(8)), null);
  // A confirm with no chatId can never match a panel renderer.
  assert.equal(bus.tryConfirm(handler, {}, ctxFor(undefined)), null);

  bus.unregister(7, fn);
  assert.equal(bus.tryConfirm(handler, {}, ctxFor(7)), null);
});

test('unregister only clears its own slot (a stale turn cannot evict a newer one)', () => {
  const bus = createPanelConfirmBus();
  const a = async (): Promise<boolean> => true;
  const b = async (): Promise<boolean> => false;
  bus.register(1, a);
  bus.register(1, b); // a newer turn replaces a
  bus.unregister(1, a); // the stale turn's cleanup must not evict b
  assert.notEqual(bus.tryConfirm(handler, {}, ctxFor(1)), null);
});
