// Pin-level asynchronous serial (8N1), shared by the virtual terminal and the
// MCU USART. Frames are real edges on real nets, so a terminal can be wired to
// any TX pin, a logic analyser can watch it, and bit-banged UARTs work too.

import type { DPin } from "../engine";
import { Drive, Level } from "../logic";

export class UartRx {
  private busy = false;
  private start = 0;
  private edges: [number, Level][] = [];

  constructor(
    private schedule: (t: number, fn: () => void) => void,
    private bitTime: () => number,
    private onByte: (byte: number, t: number, framingError: boolean) => void,
    private idleLevel: () => Level,
  ) {}

  onChange(t: number, l: Level): void {
    if (this.busy) {
      this.edges.push([t, l]);
      return;
    }
    if (l === Level.L) this.begin(t);
  }

  private begin(t: number): void {
    this.busy = true;
    this.start = t;
    this.edges = [[t, Level.L]];
    const tb = this.bitTime();
    this.schedule(t + 9.5 * tb, () => this.finish());
  }

  private levelAt(t: number): Level {
    let l = Level.H;
    for (const [et, el] of this.edges) {
      if (et <= t) l = el;
      else break;
    }
    return l;
  }

  private finish(): void {
    const tb = this.bitTime();
    let byte = 0;
    for (let i = 0; i < 8; i++) {
      if (this.levelAt(this.start + (1.5 + i) * tb) === Level.H) byte |= 1 << i;
    }
    const stopOk = this.levelAt(this.start + 9.5 * tb) === Level.H;
    const frameEnd = this.start + 9.5 * tb;
    const later = this.edges.filter(([t]) => t > this.start + 9 * tb);
    this.busy = false;
    this.onByte(byte, frameEnd, !stopOk);
    // A new start bit may already have arrived during the stop bit.
    const nextStart = later.find(([, l]) => l === Level.L);
    if (nextStart) {
      const rest = later.slice(later.indexOf(nextStart) + 1);
      this.begin(nextStart[0]);
      this.edges.push(...rest);
    } else if (this.idleLevel() === Level.L) {
      this.begin(frameEnd);
    }
  }
}

/** Queue one 8N1 frame on a pin starting at t; returns the time the stop bit ends. */
export function uartSend(pin: DPin, t: number, byte: number, bitTime: number): number {
  pin.set(t, Drive.SL);
  let level = 0;
  for (let i = 0; i < 8; i++) {
    const b = (byte >> i) & 1;
    if (b !== level) {
      pin.set(t + (i + 1) * bitTime, b ? Drive.SH : Drive.SL);
      level = b;
    }
  }
  if (!level) pin.set(t + 9 * bitTime, Drive.SH);
  return t + 10 * bitTime;
}
