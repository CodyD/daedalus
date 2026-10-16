// Built-in AVR variant descriptions. Register addresses are data-space
// addresses from the ATmega328P datasheet "Register Summary"; vector numbers
// from its "Interrupt Vectors" table.

import type { AvrVariant } from "../../../shared/component";

export const ATMEGA328P: AvrVariant = {
  flashBytes: 32768,
  sramBytes: 2048,
  eepromBytes: 1024,
  sramStart: 0x100,
  vectorWords: 2,
  sreg: 0x5f,
  spl: 0x5d,
  sph: 0x5e,
  ports: [
    { name: "B", pin: 0x23, ddr: 0x24, port: 0x25 },
    { name: "C", pin: 0x26, ddr: 0x27, port: 0x28 },
    { name: "D", pin: 0x29, ddr: 0x2a, port: 0x2b },
  ],
  timers: [
    {
      name: "TIMER0", bits: 8,
      regs: { TCCRA: 0x44, TCCRB: 0x45, TCNT: 0x46, OCRA: 0x47, OCRB: 0x48, TIMSK: 0x6e, TIFR: 0x35 },
      vectors: { ovf: 16, compa: 14, compb: 15 },
      ocPins: { a: "PD6", b: "PD5" },
      prescalers: [1, 8, 64, 256, 1024, 0, 0],
    },
    {
      name: "TIMER1", bits: 16,
      regs: { TCCRA: 0x80, TCCRB: 0x81, TCNT: 0x84, OCRA: 0x88, OCRB: 0x8a, ICR: 0x86, TIMSK: 0x6f, TIFR: 0x36 },
      vectors: { ovf: 13, compa: 11, compb: 12, capt: 10 },
      ocPins: { a: "PB1", b: "PB2" },
      prescalers: [1, 8, 64, 256, 1024, 0, 0],
    },
    {
      name: "TIMER2", bits: 8,
      regs: { TCCRA: 0xb0, TCCRB: 0xb1, TCNT: 0xb2, OCRA: 0xb3, OCRB: 0xb4, TIMSK: 0x70, TIFR: 0x37 },
      vectors: { ovf: 9, compa: 7, compb: 8 },
      ocPins: { a: "PB3", b: "PD3" },
      prescalers: [1, 8, 32, 64, 128, 256, 1024],
    },
  ],
  usart: {
    UDR: 0xc6, UCSRA: 0xc0, UCSRB: 0xc1, UCSRC: 0xc2, UBRRL: 0xc4, UBRRH: 0xc5,
    rxPin: "PD0", txPin: "PD1",
    vectors: { rx: 18, udre: 19, tx: 20 },
  },
  adc: {
    ADCL: 0x78, ADCH: 0x79, ADCSRA: 0x7a, ADCSRB: 0x7b, ADMUX: 0x7c,
    channels: ["PC0", "PC1", "PC2", "PC3", "PC4", "PC5"],
    vector: 21,
    internalRef: 1.1,
  },
  extInt: { EICRA: 0x69, EIMSK: 0x3d, EIFR: 0x3c, pins: ["PD2", "PD3"], vectors: [1, 2] },
  pcint: {
    PCICR: 0x68, PCIFR: 0x3b,
    groups: [
      { mask: 0x6b, port: "B", vector: 3 },
      { mask: 0x6c, port: "C", vector: 4 },
      { mask: 0x6d, port: "D", vector: 5 },
    ],
  },
  eeprom: { EECR: 0x3f, EEDR: 0x40, EEARL: 0x41, EEARH: 0x42 },
};

/**
 * Assembler symbol table for ATmega328P (avrasm convention: registers below
 * 0x60 use I/O addresses for IN/OUT/SBI/CBI; extended registers use data
 * addresses for LDS/STS).
 */
export const M328P_SYMBOLS: Record<string, number> = {
  PINB: 0x03, DDRB: 0x04, PORTB: 0x05, PINC: 0x06, DDRC: 0x07, PORTC: 0x08, PIND: 0x09, DDRD: 0x0a, PORTD: 0x0b,
  TIFR0: 0x15, TIFR1: 0x16, TIFR2: 0x17, PCIFR: 0x1b, EIFR: 0x1c, EIMSK: 0x1d, GPIOR0: 0x1e,
  EECR: 0x1f, EEDR: 0x20, EEARL: 0x21, EEARH: 0x22,
  TCCR0A: 0x24, TCCR0B: 0x25, TCNT0: 0x26, OCR0A: 0x27, OCR0B: 0x28,
  SPCR: 0x2c, SPSR: 0x2d, SPDR: 0x2e, SMCR: 0x33, MCUSR: 0x34, MCUCR: 0x35,
  SPL: 0x3d, SPH: 0x3e, SREG: 0x3f,
  WDTCSR: 0x60, CLKPR: 0x61, PCICR: 0x68, EICRA: 0x69, PCMSK0: 0x6b, PCMSK1: 0x6c, PCMSK2: 0x6d,
  TIMSK0: 0x6e, TIMSK1: 0x6f, TIMSK2: 0x70,
  ADCL: 0x78, ADCH: 0x79, ADCSRA: 0x7a, ADCSRB: 0x7b, ADMUX: 0x7c, DIDR0: 0x7e,
  TCCR1A: 0x80, TCCR1B: 0x81, TCCR1C: 0x82, TCNT1L: 0x84, TCNT1H: 0x85, ICR1L: 0x86, ICR1H: 0x87,
  OCR1AL: 0x88, OCR1AH: 0x89, OCR1BL: 0x8a, OCR1BH: 0x8b,
  TCCR2A: 0xb0, TCCR2B: 0xb1, TCNT2: 0xb2, OCR2A: 0xb3, OCR2B: 0xb4,
  UCSR0A: 0xc0, UCSR0B: 0xc1, UCSR0C: 0xc2, UBRR0L: 0xc4, UBRR0H: 0xc5, UDR0: 0xc6,
  RAMEND: 0x8ff,
  // bit numbers
  TOIE0: 0, OCIE0A: 1, TOV0: 0, OCF0A: 1, CS00: 0, CS01: 1, CS02: 2, WGM01: 1, WGM00: 0, COM0A0: 6, COM0A1: 7,
  TOIE1: 0, OCIE1A: 1, WGM12: 3, CS10: 0, CS11: 1, CS12: 2,
  RXEN0: 4, TXEN0: 3, RXCIE0: 7, UDRIE0: 5, UDRE0: 5, RXC0: 7, TXC0: 6, U2X0: 1, UCSZ00: 1, UCSZ01: 2,
  ADEN: 7, ADSC: 6, ADIF: 4, ADIE: 3, ADPS0: 0, ADPS1: 1, ADPS2: 2, REFS0: 6, REFS1: 7, ADLAR: 5,
  INT0: 0, INT1: 1, ISC00: 0, ISC01: 1, ISC10: 2, ISC11: 3,
  SE: 0, SM0: 1, SM1: 2, SM2: 3,
  // remaining timer / interrupt / USART bit names from the datasheet
  OCF0B: 2, OCIE0B: 2, COM0B0: 4, COM0B1: 5, WGM02: 3, FOC0A: 7, FOC0B: 6,
  TOV1: 0, OCF1A: 1, OCF1B: 2, ICF1: 5, OCIE1B: 2, ICIE1: 5, WGM10: 0, WGM11: 1, WGM13: 4,
  COM1A0: 6, COM1A1: 7, COM1B0: 4, COM1B1: 5, ICES1: 6, ICNC1: 7,
  TOV2: 0, OCF2A: 1, OCF2B: 2, TOIE2: 0, OCIE2A: 1, OCIE2B: 2, WGM20: 0, WGM21: 1, WGM22: 3,
  COM2A0: 6, COM2A1: 7, COM2B0: 4, COM2B1: 5, CS20: 0, CS21: 1, CS22: 2,
  TXCIE0: 6, UCSZ02: 2, FE0: 4, DOR0: 3, UPE0: 2, MPCM0: 0, USBS0: 3, UPM00: 4, UPM01: 5,
  INTF0: 0, INTF1: 1, PCIE0: 0, PCIE1: 1, PCIE2: 2, PCIF0: 0, PCIF1: 1, PCIF2: 2,
  ADATE: 5, MUX0: 0, MUX1: 1, MUX2: 2, MUX3: 3,
  EERE: 0, EEPE: 1, EEMPE: 2, EERIE: 3, PUD: 4,
  PB0: 0, PB1: 1, PB2: 2, PB3: 3, PB4: 4, PB5: 5, PB6: 6, PB7: 7,
  PC0: 0, PC1: 1, PC2: 2, PC3: 3, PC4: 4, PC5: 5, PC6: 6,
  PD0: 0, PD1: 1, PD2: 2, PD3: 3, PD4: 4, PD5: 5, PD6: 6, PD7: 7,
};
