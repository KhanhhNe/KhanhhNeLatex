// Coalesce waiting work by stable device ID, without overlapping a document's operations.
export class DocumentQueue {
  constructor(limit = 2) {
    this.limit = limit;
    this.pending = new Map();
    this.running = new Set();
  }
  run(code, work) {
    return new Promise((resolve, reject) => {
      const previous = this.pending.get(code);
      this.pending.set(code, { work, waiters: [...(previous?.waiters || []), { resolve, reject }] });
      this.drain();
    });
  }
  drain() {
    for (const [code, task] of this.pending) {
      if (this.running.size >= this.limit) break;
      if (this.running.has(code)) continue;
      this.pending.delete(code);
      this.running.add(code);
      Promise.resolve().then(task.work).then(
        result => { for (const waiter of task.waiters) waiter.resolve(result); },
        error => { for (const waiter of task.waiters) waiter.reject(error); },
      ).finally(() => { this.running.delete(code); this.drain(); });
    }
  }
}
