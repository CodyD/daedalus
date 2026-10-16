import { describe, expect, it } from "vitest";
import { assemble } from "../src/sim/mcu/avr/asm";
import { AvrCore } from "../src/sim/mcu/avr/core";
import { ATMEGA328P, M328P_SYMBOLS } from "../src/sim/mcu/avr/variants";
import { parseIntelHex, toIntelHex } from "../src/sim/mcu/hex";
import { Level } from "../src/sim/logic";
import { Circuit } from "./helpers";

const asm = (src: string) => assemble(src, M328P_SYMBOLS);
const words = (src: string) => {
  const b = asm(src).bytes;
  return Array.from({ length: b.length / 2 }, (_, i) => b[2 * i] | (b[2 * i + 1] << 8));
};

function bareCore(src: string): AvrCore {
  const v = ATMEGA328P;
  const core = new AvrCore({ flashBytes: v.flashBytes, ramEnd: 0x8ff, sreg: v.sreg, spl: v.spl, sph: v.sph, vectorWords: 2 });
  core.loadProgram(asm(src).bytes);
  return core;
}

const STACK = `
  ldi r16, high(RAMEND)
  out SPH, r16
  ldi r16, low(RAMEND)
  out SPL, r16`;

describe("AVR assembler", () => {
  it("encodes against known opcodes from the instruction set manual", () => {
    expect(words("ldi r16, 0xFF")).toEqual([0xef0f]);
    expect(words("out PORTB, r16")).toEqual([0xb905]);
    expect(words("sbi DDRB, 5")).toEqual([0x9a25]);
    expect(words("ret\nreti\nnop\ncli\nsei")).toEqual([0x9508, 0x9518, 0x0000, 0x94f8, 0x9478]);
    expect(words("self: rjmp self")).toEqual([0xcfff]);
    expect(words("lds r24, 0x0100")).toEqual([0x9180, 0x0100]);
    expect(words("call 0x1234")).toEqual([0x940e, 0x1234]);
    expect(words("ld r0, X+\nst -Y, r1\nldd r2, Z+5\nstd Y+63, r3")).toEqual([0x900d, 0x921a, 0x8025, 0xae3f]);
    expect(words("adiw r24, 1\nsbiw r30, 63")).toEqual([0x9601, 0x97ff]);
    expect(words("movw r24, r30\nmul r16, r17")).toEqual([0x01cf, 0x9f01]);
  });

  it("round-trips Intel HEX", () => {
    const { bytes } = asm(".db 1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18");
    expect(Array.from(parseIntelHex(toIntelHex(bytes)))).toEqual(Array.from(bytes));
  });
});

describe("AVR core", () => {
  it("executes ALU, stack, flash and SRAM instructions", () => {
    const core = bareCore(`${STACK}
  ldi r16, 200
  ldi r17, 100
  add r16, r17          ; 300 -> 44, carry
  in r2, SREG
  ldi r24, low(1000)
  ldi r25, high(1000)
  adiw r24, 50          ; 1050
  ldi r20, 200
  ldi r21, 3
  mul r20, r21          ; r1:r0 = 600
  movw r4, r0
  rcall sub
  ldi ZL, low(table*2)
  ldi ZH, high(table*2)
  lpm r23, Z+
  lpm r6, Z
  sts 0x0200, r23
  lds r7, 0x0200
  ldi r19, 10
  clr r8
loop:
  inc r8
  dec r19
  brne loop
  ldi r18, 5
  cpi r18, 6
  in r3, SREG
done: rjmp done
sub:
  ldi r22, 0x55
  ret
table: .db 0x42, 0x43
`);
    core.run(2000);
    const r = core.data;
    expect(r[16]).toBe(44);
    expect(r[2] & 1).toBe(1); // C after 200+100
    expect(r[24] | (r[25] << 8)).toBe(1050);
    expect(r[4] | (r[5] << 8)).toBe(600);
    expect(r[22]).toBe(0x55);
    expect(r[23]).toBe(0x42);
    expect(r[6]).toBe(0x43);
    expect(r[7]).toBe(0x42);
    expect(r[8]).toBe(10);
    expect(r[3] & 0b101).toBe(0b101); // C and N after 5 - 6
    expect(core.sp).toBe(0x8ff);
  });

  it("counts cycles per the datasheet (rjmp loop of dec/brne)", () => {
    const core = bareCore(`
  ldi r16, 100     ; 1
loop:
  dec r16          ; 1
  brne loop        ; 2 taken / 1 not
done: rjmp done`);
    core.run(1 + 99 * 3 + 2);
    expect(core.data[16]).toBe(0);
    expect(core.pc).toBe(asm("ldi r16,1\nl: dec r16\nbrne l\ndone: rjmp done").labels.done);
  });

  it("handles signed arithmetic flags", () => {
    const core = bareCore(`
  ldi r16, 0x7F
  inc r16           ; overflow to 0x80: V=1 N=1
  in r2, SREG
  ldi r17, 0x80
  neg r17           ; 0x80 stays 0x80: V=1
  in r3, SREG
  ldi r18, 0x81
  asr r18           ; 0xC0, C=1
  in r4, SREG
done: rjmp done`);
    core.run(100);
    expect(core.data[2] & 0b1100).toBe(0b1100);
    expect(core.data[17]).toBe(0x80);
    expect(core.data[3] & 0b1000).toBe(0b1000);
    expect(core.data[18]).toBe(0xc0);
    expect(core.data[4] & 1).toBe(1);
  });
});

function mcuCircuit(program: string) {
  const hex = toIntelHex(asm(program).bytes);
  return new Circuit().add("U1", "ATMEGA328P", {}, { PROGRAM: hex });
}

describe("ATmega328P in a circuit", () => {
  it("blinks PB5 from a Timer0 overflow interrupt at 16 MHz / 1024 / 256", () => {
    const sim = mcuCircuit(`
.org 0
  jmp reset
.org 0x20              ; TIMER0_OVF (vector 16)
  jmp t0ovf
.org 0x34
reset:${STACK}
  sbi DDRB, 5
  ldi r16, 0b101       ; clk/1024
  out TCCR0B, r16
  ldi r16, 1<<TOIE0
  sts TIMSK0, r16
  sei
main: rjmp main
t0ovf:
  sbi PINB, 5          ; toggle
  reti
`)
      .add("P", "POWER").add("R1", "RES", { R: "330" }).add("D1", "LED-RED").add("LP", "LOGICPROBE")
      .net("LED", "U1.PB5", "R1.A", "LP.D").net("A", "R1.B", "D1.A").net("GND", "D1.K")
      .sim();
    const level = () => (sim.indicateAll().LP as { level: Level }).level;
    const edges: number[] = [];
    let last = level();
    for (let t = 0; t <= 0.1; t += 1e-4) {
      sim.runUntil(t);
      const l = level();
      if (l !== last) edges.push(t);
      last = l;
    }
    const period = 1024 * 256 / 16e6; // 16.384 ms between toggles
    expect(edges.length).toBe(6);
    expect(edges[0]).toBeCloseTo(period, 3);
    expect(edges[1] - edges[0]).toBeCloseTo(period, 3);
    sim.runUntil(7 * period + 1e-3); // just after the 7th toggle: LED on
    expect((sim.indicateAll().D1 as { brightness: number }).brightness).toBeGreaterThan(0.5);
  });

  it("prints to a virtual terminal through the USART", () => {
    const sim = mcuCircuit(`${STACK}
  ldi r16, 103          ; 9600 baud at 16 MHz
  sts UBRR0L, r16
  ldi r16, 1<<TXEN0
  sts UCSR0B, r16
  ldi ZL, low(msg*2)
  ldi ZH, high(msg*2)
next:
  lpm r16, Z+
  tst r16
  breq done
wait:
  lds r17, UCSR0A
  sbrs r17, UDRE0
  rjmp wait
  sts UDR0, r16
  rjmp next
done: rjmp done
msg: .db "Hello, world!", 13, 10, 0
`).add("T1", "VTERM", { BAUD: "9600" }).net("TX", "U1.PD1", "T1.RXD").sim();
    sim.runUntil(0.02);
    expect((sim.indicateAll().T1 as { text: string }).text).toBe("Hello, world!\n");
  });

  it("echoes terminal input using the RX-complete interrupt", () => {
    const sim = mcuCircuit(`
.org 0
  jmp reset
.org 0x24                ; USART_RX (vector 18)
  jmp rx
.org 0x34
reset:${STACK}
  ldi r16, 103
  sts UBRR0L, r16
  ldi r16, (1<<TXEN0)|(1<<RXEN0)|(1<<RXCIE0)
  sts UCSR0B, r16
  sei
main: rjmp main
rx:
  lds r16, UDR0
  inc r16
  sts UDR0, r16
  reti
`).add("T1", "VTERM").net("TX", "U1.PD1", "T1.RXD").net("RX", "U1.PD0", "T1.TXD").sim();
    sim.runUntil(1e-3);
    sim.actuate("T1", { send: "HAL" });
    sim.runUntil(0.01);
    expect((sim.indicateAll().T1 as { text: string }).text).toBe("IBM");
  });

  it("converts a potentiometer voltage with the ADC", () => {
    const c = mcuCircuit(`${STACK}
  ser r16
  out DDRD, r16
  ldi r16, (1<<REFS0)|(1<<ADLAR)   ; AVCC reference, channel 0, left-adjust
  sts ADMUX, r16
again:
  ldi r16, (1<<ADEN)|(1<<ADSC)|7
  sts ADCSRA, r16
busy:
  lds r16, ADCSRA
  sbrc r16, ADSC
  rjmp busy
  lds r17, ADCH
  out PORTD, r17
  rjmp again
`).add("P", "POWER").add("RV", "POT", { POSITION: "0.25" })
      .net("VCC", "P.P", "RV.A").net("GND", "RV.B").net("W", "RV.W", "U1.PC0");
    for (let i = 0; i < 8; i++) c.net(`D${i}`, `U1.PD${i}`);
    const sim = c.sim();
    sim.runUntil(2e-3);
    const read = () => [0, 1, 2, 3, 4, 5, 6, 7].reduce((a, i) => a | ((sim.netStates()[`D${i}`].level === Level.H ? 1 : 0) << i), 0);
    // 3.75 V of 5 V -> 768 -> 0xC0 left-adjusted (±1 LSB: the divider sits on the code boundary)
    expect(Math.abs(read() - 0xc0)).toBeLessThanOrEqual(1);
    sim.actuate("RV", { position: 0.75 });
    sim.runUntil(4e-3);
    expect(Math.abs(read() - 0x40)).toBeLessThanOrEqual(1);
  });

  it("generates 25% fast PWM on OC0A", () => {
    const sim = mcuCircuit(`${STACK}
  sbi DDRD, 6
  ldi r16, 63
  out OCR0A, r16
  ldi r16, (1<<COM0A1)|(1<<WGM01)|(1<<WGM00)   ; fast PWM, non-inverting
  out TCCR0A, r16
  ldi r16, 1<<CS01                             ; clk/8 -> 7.8 kHz
  out TCCR0B, r16
main: rjmp main
`).add("LP", "LOGICPROBE").net("PWM", "U1.PD6", "LP.D").sim();
    sim.runUntil(1e-3);
    let high = 0, n = 0;
    for (let t = 1e-3; t < 5e-3; t += 1.3e-6) {
      sim.runUntil(t);
      n++;
      if ((sim.indicateAll().LP as { level: Level }).level === Level.H) high++;
    }
    expect(high / n).toBeGreaterThan(0.23);
    expect(high / n).toBeLessThan(0.27);
  });

  it("wakes on INT0 falling edge from a push button with pull-up", () => {
    const sim = mcuCircuit(`
.org 0
  jmp reset
.org 0x02               ; INT0 (vector 1)
  jmp int0
.org 0x34
reset:${STACK}
  sbi PORTD, 2          ; pull-up on PD2
  sbi DDRB, 0
  ldi r16, 1<<ISC01     ; falling edge
  sts EICRA, r16
  sbi EIMSK, INT0
  sei
main: rjmp main
int0:
  sbi PINB, 0
  reti
`).add("SW", "BUTTON").add("LP", "LOGICPROBE")
      .net("BTN", "U1.PD2", "SW.A").net("GND", "SW.B").net("OUT", "U1.PB0", "LP.D").sim();
    sim.runUntil(1e-3);
    expect((sim.indicateAll().LP as { level: Level }).level).toBe(Level.L);
    sim.actuate("SW", { pressed: true });
    sim.runUntil(2e-3);
    sim.actuate("SW", { pressed: false });
    sim.runUntil(3e-3);
    expect((sim.indicateAll().LP as { level: Level }).level).toBe(Level.H);
  });
});
