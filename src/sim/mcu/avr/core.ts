// AVR8 (enhanced core, ATmega-class) instruction-set simulator.
//
// Cycle counts follow the AVR Instruction Set Manual for devices with a 16-bit
// PC. Peripherals hook into the I/O space through read/write callbacks and
// tell the core when they next need servicing (`nextEvent`), so timers cost
// nothing between overflow/compare points.

export interface IrqSource {
  vector: number;
  pending(): boolean;
  /** Hardware clears the flag when the vector is taken (e.g. TOV, OCF, INTF). */
  ack(): void;
}

export interface Peripheral {
  /** Bring internal state up to `cycle`; fire flags/pin events that are due. */
  service(cycle: number): void;
  /** Next cycle at which service() must run (Infinity when idle). */
  nextEvent(): number;
}

const C = 0, Z = 1, N = 2, V = 3, S = 4, H = 5, T = 6, I = 7;

export class AvrCore {
  readonly flash: Uint16Array;
  readonly data: Uint8Array;
  pc = 0;
  cycles = 0;
  sleeping = false;
  breakHit = false;
  readHooks: (((addr: number) => number) | undefined)[] = [];
  writeHooks: (((v: number, addr: number, old: number) => void) | undefined)[] = [];
  private irqs: IrqSource[] = [];
  private peripherals: Peripheral[] = [];
  private nextService = Infinity;
  private irqDirty = true;
  private pendingIrq: IrqSource | null = null;
  private skipIrqOnce = false;
  readonly sregAddr: number;
  readonly splAddr: number;
  readonly sphAddr: number;
  readonly ramEnd: number;
  /** Callback when firmware executes an invalid opcode. */
  onFault?: (msg: string) => void;

  constructor(opts: { flashBytes: number; ramEnd: number; sreg: number; spl: number; sph?: number; vectorWords: number }) {
    this.flash = new Uint16Array(opts.flashBytes >> 1);
    this.data = new Uint8Array(opts.ramEnd + 1);
    this.ramEnd = opts.ramEnd;
    this.sregAddr = opts.sreg;
    this.splAddr = opts.spl;
    this.sphAddr = opts.sph ?? -1;
    this.vectorWords = opts.vectorWords;
    this.reset();
  }
  readonly vectorWords: number;

  reset(): void {
    this.pc = 0;
    this.data.fill(0);
    this.sp = this.ramEnd;
    this.sleeping = false;
    this.irqDirty = true;
  }

  loadProgram(bytes: Uint8Array): void {
    this.flash.fill(0xffff);
    for (let i = 0; i + 1 < bytes.length && i / 2 < this.flash.length; i += 2) {
      this.flash[i >> 1] = bytes[i] | (bytes[i + 1] << 8);
    }
    if (bytes.length & 1) this.flash[bytes.length >> 1] = bytes[bytes.length - 1] | 0xff00;
  }

  addIrq(src: IrqSource): void {
    this.irqs.push(src);
    this.irqs.sort((a, b) => a.vector - b.vector);
  }

  addPeripheral(p: Peripheral): void {
    this.peripherals.push(p);
  }

  /** Peripherals call this whenever an interrupt flag or enable bit changes. */
  irqChanged(): void {
    this.irqDirty = true;
  }

  /** Peripherals call this when their nextEvent() moved earlier. */
  reschedule(): void {
    let n = Infinity;
    for (const p of this.peripherals) n = Math.min(n, p.nextEvent());
    this.nextService = n;
  }

  get sp(): number {
    return this.data[this.splAddr] | (this.sphAddr >= 0 ? this.data[this.sphAddr] << 8 : 0);
  }
  set sp(v: number) {
    this.data[this.splAddr] = v & 0xff;
    if (this.sphAddr >= 0) this.data[this.sphAddr] = (v >> 8) & 0xff;
  }
  get sreg(): number {
    return this.data[this.sregAddr];
  }
  set sreg(v: number) {
    this.data[this.sregAddr] = v;
  }

  private flag(bit: number): number {
    return (this.data[this.sregAddr] >> bit) & 1;
  }

  readData(addr: number): number {
    const h = this.readHooks[addr];
    if (h) return h(addr) & 0xff;
    return this.data[addr] ?? 0;
  }

  writeData(addr: number, v: number): void {
    v &= 0xff;
    const h = this.writeHooks[addr];
    if (h) {
      const old = this.data[addr];
      this.data[addr] = v;
      h(v, addr, old);
      return;
    }
    if (addr === this.sregAddr && v & 0x80) this.irqDirty = true;
    if (addr <= this.ramEnd) this.data[addr] = v;
  }

  push(v: number): void {
    const sp = this.sp;
    this.data[sp] = v;
    this.sp = sp - 1;
  }

  pop(): number {
    const sp = this.sp + 1;
    this.sp = sp;
    return this.data[sp];
  }

  private pushPc(pc: number): void {
    this.push(pc & 0xff);
    this.push((pc >> 8) & 0xff);
  }

  private popPc(): number {
    const hi = this.pop();
    const lo = this.pop();
    return (hi << 8) | lo;
  }

  private service(): void {
    for (const p of this.peripherals) if (p.nextEvent() <= this.cycles) p.service(this.cycles);
    this.reschedule();
  }

  /** Bring every peripheral up to date (called at slice boundaries). */
  syncPeripherals(): void {
    for (const p of this.peripherals) p.service(this.cycles);
    this.reschedule();
  }

  /** Execute until the cycle counter reaches `end`. */
  run(end: number): void {
    while (this.cycles < end) {
      if (this.cycles >= this.nextService) this.service();
      if (this.irqDirty) {
        this.irqDirty = false;
        this.pendingIrq = null;
        for (const s of this.irqs) if (s.pending()) { this.pendingIrq = s; break; }
      }
      if (this.pendingIrq && this.data[this.sregAddr] & 0x80) {
        if (this.skipIrqOnce) {
          this.skipIrqOnce = false;
        } else {
          const src = this.pendingIrq;
          src.ack();
          this.irqDirty = true;
          this.sleeping = false;
          this.pushPc(this.pc);
          this.data[this.sregAddr] &= 0x7f;
          this.pc = src.vector * this.vectorWords;
          this.cycles += 4;
          continue;
        }
      } else if (this.pendingIrq && this.sleeping) {
        // Interrupt pending but I=0: wake without vectoring (AVR behaviour).
        this.sleeping = false;
      }
      if (this.sleeping) {
        // Jump straight to whatever happens next.
        const target = Math.min(end, this.nextService);
        this.cycles = Math.max(this.cycles + 1, target);
        continue;
      }
      this.step();
    }
  }

  private fault(msg: string): void {
    this.onFault?.(`${msg} at PC=0x${(this.pc * 2).toString(16)}`);
  }

  private isTwoWord(op: number): boolean {
    return (op & 0xfc0f) === 0x9000 || (op & 0xfe0e) === 0x940c;
  }

  private skip(): void {
    const next = this.flash[this.pc];
    const words = this.isTwoWord(next) ? 2 : 1;
    this.pc += words;
    this.cycles += words;
  }

  // Flag helpers ------------------------------------------------------------

  private setFlags(mask: number, values: number): void {
    const s = this.data[this.sregAddr];
    this.data[this.sregAddr] = (s & ~mask) | (values & mask);
  }

  private addFlags(rd: number, rr: number, r: number, carry: boolean): void {
    const h = ((rd & rr) | (rr & ~r) | (~r & rd)) & 0x08;
    const c = ((rd & rr) | (rr & ~r) | (~r & rd)) & 0x80;
    const v = ((rd & rr & ~r) | (~rd & ~rr & r)) & 0x80;
    const n = r & 0x80;
    let f = 0;
    if (c) f |= 1 << C;
    if ((r & 0xff) === 0) f |= 1 << Z;
    if (n) f |= 1 << N;
    if (v) f |= 1 << V;
    if (!!n !== !!v) f |= 1 << S;
    if (h) f |= 1 << H;
    void carry;
    this.setFlags(0x3f, f);
  }

  /** Flags for SUB/SBC/CP/CPC/SUBI/SBCI/CPI; `keepZ` implements the SBC Z rule. */
  private subFlags(rd: number, rr: number, r: number, keepZ: boolean): void {
    const h = ((~rd & rr) | (rr & r) | (r & ~rd)) & 0x08;
    const c = ((~rd & rr) | (rr & r) | (r & ~rd)) & 0x80;
    const v = ((rd & ~rr & ~r) | (~rd & rr & r)) & 0x80;
    const n = r & 0x80;
    let f = 0;
    if (c) f |= 1 << C;
    const zero = (r & 0xff) === 0;
    if (keepZ ? zero && this.flag(Z) : zero) f |= 1 << Z;
    if (n) f |= 1 << N;
    if (v) f |= 1 << V;
    if (!!n !== !!v) f |= 1 << S;
    if (h) f |= 1 << H;
    this.setFlags(0x3f, f);
  }

  private logicFlags(r: number): void {
    let f = 0;
    if ((r & 0xff) === 0) f |= 1 << Z;
    if (r & 0x80) f |= (1 << N) | (1 << S);
    this.setFlags((1 << Z) | (1 << N) | (1 << V) | (1 << S), f);
  }

  private shiftFlags(r: number, c: number, nOverride?: number): void {
    const n = nOverride ?? (r >> 7) & 1;
    const v = n ^ c;
    let f = 0;
    if (c) f |= 1 << C;
    if ((r & 0xff) === 0) f |= 1 << Z;
    if (n) f |= 1 << N;
    if (v) f |= 1 << V;
    if (n ^ v) f |= 1 << S;
    this.setFlags(0x1f, f);
  }

  private reg16(lo: number): number {
    return this.data[lo] | (this.data[lo + 1] << 8);
  }

  private setReg16(lo: number, v: number): void {
    this.data[lo] = v & 0xff;
    this.data[lo + 1] = (v >> 8) & 0xff;
  }

  private ioRead(a: number): number {
    return this.readData(a + 0x20);
  }

  private ioWrite(a: number, v: number): void {
    this.writeData(a + 0x20, v);
  }

  /** Execute one instruction. */
  step(): void {
    const d = this.data;
    const op = this.flash[this.pc] ?? 0xffff;
    this.pc = (this.pc + 1) & 0xffff;
    const rd5 = (op >> 4) & 0x1f;
    const rr5 = (op & 0x0f) | ((op >> 5) & 0x10);
    const rd4 = 16 + ((op >> 4) & 0x0f);
    const k8 = ((op >> 4) & 0xf0) | (op & 0x0f);

    switch (op >> 12) {
      case 0x0: {
        if (op === 0) { this.cycles++; return; } // NOP
        const sub = (op >> 10) & 3;
        if (sub === 0) {
          const hi = (op >> 8) & 3;
          if (hi === 1) { // MOVW
            const dd = ((op >> 4) & 0xf) * 2, rr = (op & 0xf) * 2;
            d[dd] = d[rr]; d[dd + 1] = d[rr + 1];
            this.cycles++;
            return;
          }
          if (hi === 2) { // MULS
            const a = (d[16 + ((op >> 4) & 0xf)] << 24) >> 24;
            const b = (d[16 + (op & 0xf)] << 24) >> 24;
            this.mulResult(a * b);
            return;
          }
          if (hi === 3) { // MULSU / FMUL / FMULS / FMULSU
            const ra = 16 + ((op >> 4) & 7), rb = 16 + (op & 7);
            const sel = ((op >> 6) & 2) | ((op >> 3) & 1);
            const sa = (d[ra] << 24) >> 24, sb = (d[rb] << 24) >> 24;
            if (sel === 0) this.mulResult(sa * d[rb]);
            else if (sel === 1) this.mulResult(d[ra] * d[rb], true);
            else if (sel === 2) this.mulResult(sa * sb, true);
            else this.mulResult(sa * d[rb], true);
            return;
          }
          this.fault(`invalid opcode 0x${op.toString(16)}`);
          this.cycles++;
          return;
        }
        const a = d[rd5], b = d[rr5];
        if (sub === 1) { // CPC
          const r = (a - b - this.flag(C)) & 0xff;
          this.subFlags(a, b, r, true);
        } else if (sub === 2) { // SBC
          const r = (a - b - this.flag(C)) & 0xff;
          this.subFlags(a, b, r, true);
          d[rd5] = r;
        } else { // ADD
          const r = (a + b) & 0xff;
          this.addFlags(a, b, r, false);
          d[rd5] = r;
        }
        this.cycles++;
        return;
      }
      case 0x1: {
        const sub = (op >> 10) & 3;
        const a = d[rd5], b = d[rr5];
        if (sub === 0) { // CPSE
          this.cycles++;
          if (a === b) this.skip();
          return;
        }
        if (sub === 1) { // CP
          this.subFlags(a, b, (a - b) & 0xff, false);
        } else if (sub === 2) { // SUB
          const r = (a - b) & 0xff;
          this.subFlags(a, b, r, false);
          d[rd5] = r;
        } else { // ADC
          const r = (a + b + this.flag(C)) & 0xff;
          this.addFlags(a, b, r, true);
          d[rd5] = r;
        }
        this.cycles++;
        return;
      }
      case 0x2: {
        const sub = (op >> 10) & 3;
        let r: number;
        if (sub === 3) { d[rd5] = d[rr5]; this.cycles++; return; } // MOV
        if (sub === 0) r = d[rd5] & d[rr5]; // AND
        else if (sub === 1) r = d[rd5] ^ d[rr5]; // EOR
        else r = d[rd5] | d[rr5]; // OR
        d[rd5] = r;
        this.logicFlags(r);
        this.cycles++;
        return;
      }
      case 0x3: { // CPI
        const a = d[rd4];
        this.subFlags(a, k8, (a - k8) & 0xff, false);
        this.cycles++;
        return;
      }
      case 0x4: { // SBCI
        const a = d[rd4];
        const r = (a - k8 - this.flag(C)) & 0xff;
        this.subFlags(a, k8, r, true);
        d[rd4] = r;
        this.cycles++;
        return;
      }
      case 0x5: { // SUBI
        const a = d[rd4];
        const r = (a - k8) & 0xff;
        this.subFlags(a, k8, r, false);
        d[rd4] = r;
        this.cycles++;
        return;
      }
      case 0x6: { // ORI
        const r = d[rd4] | k8;
        d[rd4] = r;
        this.logicFlags(r);
        this.cycles++;
        return;
      }
      case 0x7: { // ANDI
        const r = d[rd4] & k8;
        d[rd4] = r;
        this.logicFlags(r);
        this.cycles++;
        return;
      }
      case 0x8:
      case 0xa: { // LDD/STD with displacement
        const q = (op & 7) | ((op >> 7) & 0x18) | ((op >> 8) & 0x20);
        const base = op & 8 ? this.reg16(28) : this.reg16(30);
        const addr = (base + q) & 0xffff;
        if (op & 0x200) this.writeData(addr, d[rd5]);
        else d[rd5] = this.readData(addr);
        this.cycles += 2;
        return;
      }
      case 0x9:
        this.exec9(op, rd5, rr5);
        return;
      case 0xb: { // IN / OUT
        const a = (op & 0xf) | ((op >> 5) & 0x30);
        if (op & 0x800) this.ioWrite(a, d[rd5]);
        else d[rd5] = this.ioRead(a);
        this.cycles++;
        return;
      }
      case 0xc: { // RJMP
        const k = ((op & 0xfff) << 20) >> 20;
        this.pc = (this.pc + k) & 0xffff;
        this.cycles += 2;
        return;
      }
      case 0xd: { // RCALL
        const k = ((op & 0xfff) << 20) >> 20;
        this.pushPc(this.pc);
        this.pc = (this.pc + k) & 0xffff;
        this.cycles += 3;
        return;
      }
      case 0xe: // LDI
        d[rd4] = k8;
        this.cycles++;
        return;
      case 0xf: {
        if ((op & 0x800) === 0) { // BRBS / BRBC
          const bit = op & 7;
          const set = (op & 0x400) === 0;
          const k = ((op >> 3) & 0x7f) << 25 >> 25;
          if (!!this.flag(bit) === set) {
            this.pc = (this.pc + k) & 0xffff;
            this.cycles += 2;
          } else this.cycles++;
          return;
        }
        const b = op & 7;
        switch ((op >> 9) & 3) {
          case 0: // BLD
            d[rd5] = this.flag(T) ? d[rd5] | (1 << b) : d[rd5] & ~(1 << b);
            this.cycles++;
            return;
          case 1: // BST
            this.setFlags(1 << T, ((d[rd5] >> b) & 1) << T);
            this.cycles++;
            return;
          case 2: // SBRC
            this.cycles++;
            if (!((d[rd5] >> b) & 1)) this.skip();
            return;
          case 3: // SBRS
            this.cycles++;
            if ((d[rd5] >> b) & 1) this.skip();
            return;
        }
      }
    }
  }

  private mulResult(product: number, fractional = false): void {
    let r = product & 0xffff;
    let c = (r >> 15) & 1;
    if (fractional) {
      c = (r >> 15) & 1;
      r = (r << 1) & 0xffff;
    }
    this.data[0] = r & 0xff;
    this.data[1] = r >> 8;
    this.setFlags((1 << C) | (1 << Z), (c << C) | ((r === 0 ? 1 : 0) << Z));
    this.cycles += 2;
  }

  private exec9(op: number, rd5: number, rr5: number): void {
    const d = this.data;
    const sub = (op >> 8) & 0xf;
    if (sub <= 1) { // loads
      this.load(op, rd5);
      return;
    }
    if (sub <= 3) {
      this.store(op, rd5);
      return;
    }
    if (sub <= 5) {
      this.single(op, rd5);
      return;
    }
    if (sub === 6 || sub === 7) { // ADIW / SBIW
      const reg = 24 + ((op >> 3) & 6);
      const k = (op & 0xf) | ((op >> 2) & 0x30);
      const v = this.reg16(reg);
      let r: number, vflag: number, c: number;
      if (sub === 6) {
        r = (v + k) & 0xffff;
        vflag = ~v & r & 0x8000;
        c = ~r & v & 0x8000;
      } else {
        r = (v - k) & 0xffff;
        vflag = v & ~r & 0x8000;
        c = r & ~v & 0x8000;
      }
      this.setReg16(reg, r);
      const n = r & 0x8000;
      let f = 0;
      if (c) f |= 1 << C;
      if (r === 0) f |= 1 << Z;
      if (n) f |= 1 << N;
      if (vflag) f |= 1 << V;
      if (!!n !== !!vflag) f |= 1 << S;
      this.setFlags(0x1f, f);
      this.cycles += 2;
      return;
    }
    if (sub >= 8 && sub <= 0xb) { // CBI SBIC SBI SBIS
      const a = (op >> 3) & 0x1f;
      const b = op & 7;
      if (sub === 8 || sub === 0xa) {
        const v = this.ioRead(a);
        // Writing PINx bits toggles PORTx; SBI/CBI on PINx writes only that bit.
        const isPin = this.pinAddrs.has(a + 0x20);
        if (isPin) this.ioWrite(a, sub === 0xa ? 1 << b : 0);
        else this.ioWrite(a, sub === 0xa ? v | (1 << b) : v & ~(1 << b));
        this.cycles += 2;
        return;
      }
      const bit = (this.ioRead(a) >> b) & 1;
      this.cycles++;
      if ((sub === 0x9 && !bit) || (sub === 0xb && bit)) this.skip();
      return;
    }
    // MUL
    const p = d[rd5] * d[rr5];
    this.mulResult(p);
  }

  /** Data addresses of PINx registers (set by the MCU model). */
  pinAddrs = new Set<number>();

  private load(op: number, rd: number): void {
    const d = this.data;
    const mode = op & 0xf;
    switch (mode) {
      case 0x0: { // LDS
        const k = this.flash[this.pc];
        this.pc = (this.pc + 1) & 0xffff;
        d[rd] = this.readData(k);
        this.cycles += 2;
        return;
      }
      case 0x1: case 0x2: { // LD Z+ / -Z
        let z = this.reg16(30);
        if (mode === 2) z = (z - 1) & 0xffff;
        d[rd] = this.readData(z);
        if (mode === 1) z = (z + 1) & 0xffff;
        this.setReg16(30, z);
        this.cycles += 2;
        return;
      }
      case 0x4: case 0x5: case 0x6: case 0x7: { // LPM / ELPM
        let z = this.reg16(30);
        const w = this.flash[z >> 1] ?? 0xffff;
        d[rd] = z & 1 ? w >> 8 : w & 0xff;
        if (mode & 1) this.setReg16(30, (z = (z + 1) & 0xffff));
        this.cycles += 3;
        return;
      }
      case 0x9: case 0xa: { // LD Y+ / -Y
        let y = this.reg16(28);
        if (mode === 0xa) y = (y - 1) & 0xffff;
        d[rd] = this.readData(y);
        if (mode === 0x9) y = (y + 1) & 0xffff;
        this.setReg16(28, y);
        this.cycles += 2;
        return;
      }
      case 0xc: case 0xd: case 0xe: { // LD X / X+ / -X
        let x = this.reg16(26);
        if (mode === 0xe) x = (x - 1) & 0xffff;
        d[rd] = this.readData(x);
        if (mode === 0xd) x = (x + 1) & 0xffff;
        if (mode !== 0xc) this.setReg16(26, x);
        this.cycles += 2;
        return;
      }
      case 0xf: // POP
        d[rd] = this.pop();
        this.cycles += 2;
        return;
    }
    this.fault(`invalid opcode 0x${op.toString(16)}`);
    this.cycles++;
  }

  private store(op: number, rr: number): void {
    const v = this.data[rr];
    const mode = op & 0xf;
    switch (mode) {
      case 0x0: { // STS
        const k = this.flash[this.pc];
        this.pc = (this.pc + 1) & 0xffff;
        this.writeData(k, v);
        this.cycles += 2;
        return;
      }
      case 0x1: case 0x2: {
        let z = this.reg16(30);
        if (mode === 2) z = (z - 1) & 0xffff;
        this.writeData(z, v);
        if (mode === 1) z = (z + 1) & 0xffff;
        this.setReg16(30, z);
        this.cycles += 2;
        return;
      }
      case 0x9: case 0xa: {
        let y = this.reg16(28);
        if (mode === 0xa) y = (y - 1) & 0xffff;
        this.writeData(y, v);
        if (mode === 0x9) y = (y + 1) & 0xffff;
        this.setReg16(28, y);
        this.cycles += 2;
        return;
      }
      case 0xc: case 0xd: case 0xe: {
        let x = this.reg16(26);
        if (mode === 0xe) x = (x - 1) & 0xffff;
        this.writeData(x, v);
        if (mode === 0xd) x = (x + 1) & 0xffff;
        if (mode !== 0xc) this.setReg16(26, x);
        this.cycles += 2;
        return;
      }
      case 0xf: // PUSH
        this.push(v);
        this.cycles += 2;
        return;
    }
    this.fault(`invalid opcode 0x${op.toString(16)}`);
    this.cycles++;
  }

  private single(op: number, rd: number): void {
    const d = this.data;
    const low = op & 0xf;
    if ((op & 0xfe0e) === 0x940c) { // JMP / CALL (16-bit PC: ignore high bits)
      const k = this.flash[this.pc];
      const ret = (this.pc + 1) & 0xffff;
      if (op & 2) {
        this.pushPc(ret);
        this.cycles += 4;
      } else this.cycles += 3;
      this.pc = k;
      return;
    }
    if (op === 0x9409 || op === 0x9419) { // IJMP / EIJMP
      this.pc = this.reg16(30);
      this.cycles += 2;
      return;
    }
    if (op === 0x9509 || op === 0x9519) { // ICALL / EICALL
      this.pushPc(this.pc);
      this.pc = this.reg16(30);
      this.cycles += 3;
      return;
    }
    if ((op & 0xff8f) === 0x9408) { // BSET
      const s = (op >> 4) & 7;
      this.data[this.sregAddr] |= 1 << s;
      if (s === I) { this.irqDirty = true; this.skipIrqOnce = true; }
      this.cycles++;
      return;
    }
    if ((op & 0xff8f) === 0x9488) { // BCLR
      this.data[this.sregAddr] &= ~(1 << ((op >> 4) & 7));
      this.cycles++;
      return;
    }
    switch (op) {
      case 0x9508: // RET
        this.pc = this.popPc();
        this.cycles += 4;
        return;
      case 0x9518: // RETI
        this.pc = this.popPc();
        this.data[this.sregAddr] |= 0x80;
        this.skipIrqOnce = true;
        this.irqDirty = true;
        this.cycles += 4;
        return;
      case 0x9588: // SLEEP
        this.sleeping = true;
        this.cycles++;
        return;
      case 0x9598: // BREAK
        this.breakHit = true;
        this.cycles++;
        return;
      case 0x95a8: // WDR
        this.cycles++;
        return;
      case 0x95c8: case 0x95d8: { // LPM / ELPM (r0 implied)
        const z = this.reg16(30);
        const w = this.flash[z >> 1] ?? 0xffff;
        d[0] = z & 1 ? w >> 8 : w & 0xff;
        this.cycles += 3;
        return;
      }
      case 0x95e8: // SPM (not modelled)
        this.cycles++;
        return;
    }
    if ((op & 0xfe00) !== 0x9400) {
      this.fault(`invalid opcode 0x${op.toString(16)}`);
      this.cycles++;
      return;
    }
    const a = d[rd];
    let r: number;
    switch (low) {
      case 0x0: // COM
        r = ~a & 0xff;
        d[rd] = r;
        this.logicFlags(r);
        this.data[this.sregAddr] |= 1 << C;
        break;
      case 0x1: { // NEG
        r = (0 - a) & 0xff;
        d[rd] = r;
        let f = 0;
        if (r !== 0) f |= 1 << C;
        if (r === 0) f |= 1 << Z;
        if (r & 0x80) f |= 1 << N;
        if (r === 0x80) f |= 1 << V;
        if (!!(r & 0x80) !== (r === 0x80)) f |= 1 << S;
        if ((r | a) & 0x08) f |= 1 << H;
        this.setFlags(0x3f, f);
        break;
      }
      case 0x2: // SWAP
        d[rd] = ((a << 4) | (a >> 4)) & 0xff;
        break;
      case 0x3: { // INC
        r = (a + 1) & 0xff;
        d[rd] = r;
        const v = r === 0x80 ? 1 : 0;
        const n = r >> 7;
        this.setFlags(0x1e, ((r === 0 ? 1 : 0) << Z) | (n << N) | (v << V) | ((n ^ v) << S));
        break;
      }
      case 0x5: // ASR
        r = (a >> 1) | (a & 0x80);
        d[rd] = r;
        this.shiftFlags(r, a & 1);
        break;
      case 0x6: // LSR
        r = a >> 1;
        d[rd] = r;
        this.shiftFlags(r, a & 1, 0);
        break;
      case 0x7: // ROR
        r = (a >> 1) | (this.flag(C) << 7);
        d[rd] = r;
        this.shiftFlags(r, a & 1);
        break;
      case 0xa: { // DEC
        r = (a - 1) & 0xff;
        d[rd] = r;
        const v = r === 0x7f ? 1 : 0;
        const n = r >> 7;
        this.setFlags(0x1e, ((r === 0 ? 1 : 0) << Z) | (n << N) | (v << V) | ((n ^ v) << S));
        break;
      }
      default:
        this.fault(`invalid opcode 0x${op.toString(16)}`);
    }
    this.cycles++;
  }
}
