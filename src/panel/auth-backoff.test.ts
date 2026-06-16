// Per-IP auth-failure backoff. The behaviour that matters:
// - an IP is blocked after maxFailures bad tokens within the window, with a
//   retry-after that counts down
// - a correct token clears an IP's failure history (so the legitimate user
//   can't lock themselves out by mistyping a few times)
// - the window slides: failures older than windowMs don't accumulate
// - the block expires after blockMs
// - a correct token DURING an active block does not lift it

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { createAuthBackoff } from './auth-backoff.js';

function clock(start = 0) {
  let t = start;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

test('an IP is blocked after maxFailures within the window, with a retry-after', () => {
  const c = clock();
  const b = createAuthBackoff({ maxFailures: 3, windowMs: 1000, blockMs: 5000, now: c.now });
  assert.equal(b.check('1.2.3.4').blocked, false);
  b.recordFailure('1.2.3.4');
  b.recordFailure('1.2.3.4');
  assert.equal(b.check('1.2.3.4').blocked, false); // 2 failures — not yet
  b.recordFailure('1.2.3.4'); // 3rd trips the block
  const gate = b.check('1.2.3.4');
  assert.equal(gate.blocked, true);
  assert.equal(gate.retryAfterMs, 5000);
  // A different IP is unaffected.
  assert.equal(b.check('9.9.9.9').blocked, false);
});

test('a correct token clears the IP failure history', () => {
  const c = clock();
  const b = createAuthBackoff({ maxFailures: 3, windowMs: 1000, blockMs: 5000, now: c.now });
  b.recordFailure('1.2.3.4');
  b.recordFailure('1.2.3.4');
  b.recordSuccess('1.2.3.4'); // clears
  b.recordFailure('1.2.3.4');
  b.recordFailure('1.2.3.4');
  assert.equal(b.check('1.2.3.4').blocked, false); // only 2 since the reset
});

test('failures older than the window do not accumulate', () => {
  const c = clock();
  const b = createAuthBackoff({ maxFailures: 3, windowMs: 1000, blockMs: 5000, now: c.now });
  b.recordFailure('1.2.3.4');
  b.recordFailure('1.2.3.4');
  c.advance(1001); // window elapsed
  b.recordFailure('1.2.3.4'); // counts as the first of a fresh window
  assert.equal(b.check('1.2.3.4').blocked, false);
});

test('the block expires after blockMs', () => {
  const c = clock();
  const b = createAuthBackoff({ maxFailures: 1, windowMs: 1000, blockMs: 5000, now: c.now });
  b.recordFailure('1.2.3.4');
  assert.equal(b.check('1.2.3.4').blocked, true);
  c.advance(5001);
  assert.equal(b.check('1.2.3.4').blocked, false);
});

test('a correct token during an active block does not lift it', () => {
  const c = clock();
  const b = createAuthBackoff({ maxFailures: 1, windowMs: 1000, blockMs: 5000, now: c.now });
  b.recordFailure('1.2.3.4');
  assert.equal(b.check('1.2.3.4').blocked, true);
  b.recordSuccess('1.2.3.4'); // must NOT clear an active block
  assert.equal(b.check('1.2.3.4').blocked, true);
});
