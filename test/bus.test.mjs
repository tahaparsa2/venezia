import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createBus } from '../engine/bus.mjs';

const event = (type, seq = 1) => ({ seq, type });

test('subscribers receive events until they unsubscribe', () => {
  const bus = createBus();
  const seen = [];
  const stop = bus.subscribe((e) => seen.push(e.type));
  bus.publish(event('a'));
  stop();
  bus.publish(event('b'));
  assert.deepEqual(seen, ['a']);
  assert.equal(bus.size, 0);
});

test('filters take a type, a prefix, a list or a predicate', () => {
  const bus = createBus();
  const seen = { exact: 0, prefix: 0, list: 0, predicate: 0 };
  bus.subscribe(() => seen.exact++, 'ship.state');
  bus.subscribe(() => seen.prefix++, 'ship.*');
  bus.subscribe(() => seen.list++, ['gate.started', 'worker.*']);
  bus.subscribe(() => seen.predicate++, (e) => e.seq > 2);
  bus.publish(event('ship.state', 1), event('ship.named', 2), event('gate.started', 3), event('worker.text', 4), event('shipment', 5));
  assert.deepEqual(seen, { exact: 1, prefix: 2, list: 2, predicate: 3 });
});

test('a failing subscriber reaches neither the publisher nor the others', async () => {
  const errors = [];
  const bus = createBus({ onError: (error) => errors.push(error.message) });
  const seen = [];
  bus.subscribe(() => { throw new Error('sync'); });
  bus.subscribe(async () => { throw new Error('async'); });
  bus.subscribe((e) => seen.push(e.type));
  bus.publish(event('a'));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(seen, ['a']);
  assert.deepEqual(errors.sort(), ['async', 'sync']);
});

test('events published during delivery keep their order for everyone', () => {
  const bus = createBus();
  const orders = { first: [], second: [] };
  bus.subscribe((e) => {
    orders.first.push(e.seq);
    if (e.seq === 1) bus.publish(event('next', 2));
  });
  bus.subscribe((e) => orders.second.push(e.seq));
  bus.publish(event('start', 1));
  assert.deepEqual(orders.first, [1, 2]);
  assert.deepEqual(orders.second, [1, 2]);
});

test('next resolves with the next match, or times out', async () => {
  const bus = createBus();
  const waiting = bus.next('b');
  bus.publish(event('a'));
  bus.publish(event('b', 7));
  assert.equal((await waiting).seq, 7);
  assert.equal(bus.size, 0);
  await assert.rejects(bus.next('never', { timeoutMs: 5 }), /No matching event/);
  assert.equal(bus.size, 0);
});

test('a subscriber removed during delivery is skipped', () => {
  const bus = createBus();
  const seen = [];
  let stopSecond;
  bus.subscribe(() => stopSecond());
  stopSecond = bus.subscribe(() => seen.push('second'));
  bus.publish(event('a'));
  assert.deepEqual(seen, []);
});
