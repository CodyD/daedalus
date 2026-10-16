; Potentiometer dimmer: ADC0 (PC0) is read continuously and copied to the
; Timer0 PWM duty cycle on OC0A (PD6). Fast PWM, clk/64 -> 976 Hz.

.def tmp = r16

.org 0
        rjmp reset
reset:
        ldi tmp, high(RAMEND)
        out SPH, tmp
        ldi tmp, low(RAMEND)
        out SPL, tmp

        sbi DDRD, 6                                 ; OC0A output
        ldi tmp, (1<<COM0A1)|(1<<WGM01)|(1<<WGM00)  ; fast PWM, non-inverting
        out TCCR0A, tmp
        ldi tmp, (1<<CS01)|(1<<CS00)                ; clk/64
        out TCCR0B, tmp

        ldi tmp, (1<<REFS0)|(1<<ADLAR)              ; AVcc reference, ADC0, 8-bit result in ADCH
        sts ADMUX, tmp
convert:
        ldi tmp, (1<<ADEN)|(1<<ADSC)|(1<<ADPS2)|(1<<ADPS1)|(1<<ADPS0)
        sts ADCSRA, tmp
busy:
        lds tmp, ADCSRA
        sbrc tmp, ADSC
        rjmp busy
        lds tmp, ADCH
        out OCR0A, tmp
        rjmp convert
