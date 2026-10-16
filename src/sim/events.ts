// Time-ordered event queue (binary min-heap). Ties resolve in insertion order
// so that events scheduled for the same instant run deterministically.

export interface SimEvent {
  time: number;
  seq: number;
  run: () => void;
}

export class EventQueue {
  private heap: SimEvent[] = [];
  private seq = 0;

  get size(): number {
    return this.heap.length;
  }

  push(time: number, run: () => void): void {
    const ev = { time, seq: this.seq++, run };
    const h = this.heap;
    h.push(ev);
    let i = h.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (less(h[p], ev)) break;
      h[i] = h[p];
      i = p;
    }
    h[i] = ev;
  }

  peekTime(): number {
    return this.heap.length ? this.heap[0].time : Infinity;
  }

  pop(): SimEvent | undefined {
    const h = this.heap;
    if (!h.length) return undefined;
    const top = h[0];
    const last = h.pop()!;
    if (h.length) {
      let i = 0;
      const n = h.length;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        let mv = last;
        if (l < n && less(h[l], mv)) { m = l; mv = h[l]; }
        if (r < n && less(h[r], mv)) { m = r; }
        if (m === i) break;
        h[i] = h[m];
        i = m;
      }
      h[i] = last;
    }
    return top;
  }

  clear(): void {
    this.heap = [];
  }
}

function less(a: SimEvent, b: SimEvent): boolean {
  return a.time < b.time || (a.time === b.time && a.seq < b.seq);
}
