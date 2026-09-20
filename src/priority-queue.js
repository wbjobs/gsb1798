// Binary min-heap priority queue.
//
// Ordering key: (priority, seq). Lower `priority` value is more important
// (0 = critical); equal priorities are FIFO via a monotonic sequence number.

export class PriorityQueue {
  constructor() {
    this._heap = [];
    this._index = new Map();
    this._seq = 0;
  }

  get size() {
    return this._heap.length;
  }

  enqueue(id, priority, data) {
    if (this._index.has(id)) {
      throw new Error(`PriorityQueue: duplicate id "${id}"`);
    }
    const node = { id, priority, seq: this._seq++, data };
    this._heap.push(node);
    this._index.set(id, this._heap.length - 1);
    this._siftUp(this._heap.length - 1);
    return this;
  }

  dequeue() {
    const heap = this._heap;
    if (heap.length === 0) return null;
    const top = heap[0];
    const last = heap.pop();
    if (heap.length > 0) {
      heap[0] = last;
      this._index.set(last.id, 0);
      this._siftDown(0);
    }
    this._index.delete(top.id);
    return { id: top.id, priority: top.priority, data: top.data };
  }

  peek() {
    const top = this._heap[0];
    return top ? { id: top.id, priority: top.priority, data: top.data } : null;
  }

  has(id) {
    return this._index.has(id);
  }

  // Remove a pending entry by id (used for cancel-before-start).
  remove(id) {
    const pos = this._index.get(id);
    if (pos === undefined) return null;
    const heap = this._heap;
    const removed = heap[pos];
    const last = heap.pop();
    this._index.delete(id);
    if (pos < heap.length) {
      heap[pos] = last;
      this._index.set(last.id, pos);
      this._siftUp(pos);
      this._siftDown(this._index.get(last.id));
    }
    return { id: removed.id, priority: removed.priority, data: removed.data };
  }

  _higher(a, b) {
    return a.priority < b.priority ||
      (a.priority === b.priority && a.seq < b.seq);
  }

  _siftUp(pos) {
    const heap = this._heap;
    const node = heap[pos];
    while (pos > 0) {
      const parent = (pos - 1) >> 1;
      if (!this._higher(node, heap[parent])) break;
      heap[pos] = heap[parent];
      this._index.set(heap[pos].id, pos);
      pos = parent;
    }
    heap[pos] = node;
    this._index.set(node.id, pos);
  }

  _siftDown(pos) {
    const heap = this._heap;
    const node = heap[pos];
    const n = heap.length;
    for (;;) {
      const left = pos * 2 + 1;
      const right = left + 1;
      let next = pos;
      let candidate = node;
      if (left < n && this._higher(heap[left], candidate)) {
        next = left;
        candidate = heap[left];
      }
      if (right < n && this._higher(heap[right], candidate)) {
        next = right;
        candidate = heap[right];
      }
      if (next === pos) {
        heap[pos] = node;
        this._index.set(node.id, pos);
        return;
      }
      heap[pos] = heap[next];
      this._index.set(heap[pos].id, pos);
      pos = next;
    }
  }
}
