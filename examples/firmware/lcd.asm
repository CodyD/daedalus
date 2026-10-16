; HD44780 16x2 LCD in 4-bit mode (same wiring as the Arduino LiquidCrystal
; examples): RS = PB0, E = PB1, D4..D7 = PD4..PD7, RW tied to ground.
; Shows a greeting and a counter that ticks every 250 ms.

.def tmp  = r16
.def arg  = r17
.def aux  = r19
.def n    = r20
.def val  = r21
.def dig  = r22

.org 0
        rjmp reset
reset:
        ldi tmp, high(RAMEND)
        out SPH, tmp
        ldi tmp, low(RAMEND)
        out SPL, tmp
        ldi tmp, 0xF0
        out DDRD, tmp           ; D4..D7 outputs
        ldi tmp, 0x03
        out DDRB, tmp           ; RS, E outputs

        ldi arg, 50
        rcall delay_ms          ; power-on wait

        ldi arg, 0x30           ; reset sequence: 3 x "8-bit mode", then 4-bit
        rcall nibble
        ldi arg, 5
        rcall delay_ms
        ldi arg, 0x30
        rcall nibble
        rcall delay_50us
        ldi arg, 0x30
        rcall nibble
        rcall delay_50us
        ldi arg, 0x20
        rcall nibble
        rcall delay_50us

        ldi arg, 0x28           ; 4-bit, 2 lines, 5x8 font
        rcall command
        ldi arg, 0x0C           ; display on, cursor off
        rcall command
        ldi arg, 0x06           ; increment, no shift
        rcall command
        ldi arg, 0x01           ; clear
        rcall command
        ldi arg, 2
        rcall delay_ms

        ldi ZL, low(line1*2)
        ldi ZH, high(line1*2)
        rcall puts
        ldi arg, 0xC0           ; DDRAM 0x40: start of line 2
        rcall command
        ldi ZL, low(line2*2)
        ldi ZH, high(line2*2)
        rcall puts
        clr n
loop:
        ldi arg, 0xC0 + 9
        rcall command
        mov val, n
        ldi dig, '0' - 1        ; hundreds
hundreds:
        inc dig
        subi val, 100
        brcc hundreds
        subi val, -100
        mov arg, dig
        rcall data
        ldi dig, '0' - 1        ; tens
tens:
        inc dig
        subi val, 10
        brcc tens
        subi val, -10
        mov arg, dig
        rcall data
        mov arg, val            ; ones
        subi arg, -'0'
        rcall data
        inc n
        ldi arg, 250
        rcall delay_ms
        rjmp loop

command:                        ; RS = 0
        cbi PORTB, 0
        rjmp send
data:                           ; RS = 1
        sbi PORTB, 0
send:
        push arg
        rcall nibble            ; high nibble
        pop arg
        swap arg
        rcall nibble            ; low nibble
        rjmp delay_50us

nibble:                         ; put arg[7:4] on D4..D7 and pulse E
        in tmp, PORTD
        andi tmp, 0x0F
        mov aux, arg
        andi aux, 0xF0
        or tmp, aux
        out PORTD, tmp
        sbi PORTB, 1
        nop
        nop
        cbi PORTB, 1            ; LCD latches on the falling edge
        ret

puts:                           ; write zero-terminated flash string at Z
        lpm arg, Z+
        tst arg
        breq puts_end
        rcall data
        rjmp puts
puts_end:
        ret

delay_50us:                     ; 200 x 4 cycles = 800 cycles = 50 us
        ldi r24, 200
d50:
        nop
        dec r24
        brne d50
        ret

delay_ms:                       ; arg milliseconds (4000 x 4 cycles per ms)
        ldi r24, low(3999)
        ldi r25, high(3999)
dms:
        sbiw r24, 1
        brne dms
        dec arg
        brne delay_ms
        ret

line1:  .db "Hello, Daedalus!", 0
line2:  .db "Counter: ", 0
