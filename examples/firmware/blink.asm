; LED blink on PB5 (Arduino pin 13) using Timer1 in CTC mode.
; 16 MHz / 1024 / (7812 + 1) = 2 Hz interrupt -> LED toggles every 0.5 s.

.org 0
        jmp reset
.org 0x16                       ; TIMER1_COMPA (vector 11)
        jmp timer1_compa
.org 0x34
reset:
        ldi r16, high(RAMEND)
        out SPH, r16
        ldi r16, low(RAMEND)
        out SPL, r16

        sbi DDRB, 5             ; PB5 output

        ldi r16, high(7812)     ; 16-bit write: high byte first
        sts OCR1AH, r16
        ldi r16, low(7812)
        sts OCR1AL, r16
        ldi r16, (1<<WGM12)|(1<<CS12)|(1<<CS10)   ; CTC, clk/1024
        sts TCCR1B, r16
        ldi r16, 1<<OCIE1A
        sts TIMSK1, r16
        sei
idle:
        rjmp idle

timer1_compa:
        sbi PINB, 5             ; writing 1 to PINx toggles PORTx
        reti
