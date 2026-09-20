export const PRIORITIES = Object.freeze({
  critical: 0,
  high: 1,
  normal: 2,
  low: 3
});

export function normalizePriority(priority) {
  if (typeof priority === 'number' && Number.isFinite(priority)) {
    return Math.min(3, Math.max(0, Math.trunc(priority)));
  }
  return PRIORITIES[priority] ?? PRIORITIES.normal;
}

export class PriorityQueue {
  constructor() {
    this.items = [];
  }

  get size() {
    return this.items.length;
  }

  enqueue(item) {
    this.items.push(item);
    this.bubbleUp(this.items.length - 1);
  }

  dequeue() {
    if (this.items.length === 0) return undefined;
    const first = this.items[0];
    const last = this.items.pop();
    if (this.items.length > 0) {
      this.items[0] = last;
      this.bubbleDown(0);
    }
    return first;
  }

  bubbleUp(index) {
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      if (this.compare(this.items[index], this.items[parent]) >= 0) break;
      [this.items[index], this.items[parent]] = [this.items[parent], this.items[index]];
      index = parent;
    }
  }

  bubbleDown(index) {
    while (true) {
      const left = index * 2 + 1;
      const right = left + 1;
      let smallest = index;
      if (left < this.items.length && this.compare(this.items[left], this.items[smallest]) < 0) {
        smallest = left;
      }
      if (right < this.items.length && this.compare(this.items[right], this.items[smallest]) < 0) {
        smallest = right;
      }
      if (smallest === index) return;
      [this.items[index], this.items[smallest]] = [this.items[smallest], this.items[index]];
      index = smallest;
    }
  }

  compare(left, right) {
    const priorityGap = left.priority - right.priority;
    if (priorityGap !== 0) return priorityGap;
    return left.sequence - right.sequence;
  }
}
