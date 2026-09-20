import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PriorityQueue } from '../src/priority-queue.js';

test('dequeues lower priority number first', () => {
  const q = new PriorityQueue();
  q.enqueue('a', 2, 'n');
  q.enqueue('b', 0, 'c');
  q.enqueue('c', 1, 'h');
  assert.deepEqual(q.dequeue().id, 'b');
  assert.deepEqual(q.dequeue().id, 'c');
  assert.deepEqual(q.dequeue().id, 'a');
  assert.equal(q.dequeue(), null);
});

test('FIFO within the same priority', () => {
  const q = new PriorityQueue();
  for (let i = 0; i < 10; i++) q.enqueue(`id${i}`, 1, i);
  const order = [];
  let item;
  while ((item = q.dequeue())) order.push(item.data);
  assert.deepEqual(order, [...Array(10).keys()]);
});

test('mixed levels keep FIFO inside levels', () => {
  const q = new PriorityQueue();
  const enqueued = ['n1', 'h1', 'l1', 'h2', 'c1', 'n2', 'c2', 'l2'];
  const level = { c: 0, h: 1, n: 2, l: 3 };
  for (const id of enqueued) q.enqueue(id, level[id[0]], id);
  const out = [];
  let item;
  while ((item = q.dequeue())) out.push(item.data);
  assert.deepEqual(out, ['c1', 'c2', 'h1', 'h2', 'n1', 'n2', 'l1', 'l2']);
});

test('remove(id) evicts pending entries and preserves order', () => {
  const q = new PriorityQueue();
  q.enqueue('a', 0, 1);
  q.enqueue('b', 0, 2);
  q.enqueue('c', 0, 3);
  assert.equal(q.remove('b').data, 2);
  assert.equal(q.has('b'), false);
  assert.equal(q.size, 2);
  assert.deepEqual(q.dequeue().id, 'a');
  assert.deepEqual(q.dequeue().id, 'c');
});

test('rejects duplicate ids', () => {
  const q = new PriorityQueue();
  q.enqueue('x', 1);
  assert.throws(() => q.enqueue('x', 1), /duplicate id/);
});

test('stress: heapsort matches a sorted reference', () => {
  const q = new PriorityQueue();
  const values = Array.from({ length: 500 }, (_, i) => [i, Math.floor(Math.random() * 5)]);
  for (const [id, p] of values) q.enqueue(`k${id}`, p, id);
  const reference = values
    .map(([seq, p]) => ({ seq, p }))
    .sort((a, b) => a.p - b.p || a.seq - b.seq);
  const drained = [];
  let item;
  while ((item = q.dequeue())) drained.push({ seq: item.data, p: item.priority });
  assert.equal(drained.length, 500);
  assert.deepEqual(drained, reference);
});
