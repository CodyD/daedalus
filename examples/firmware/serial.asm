; USART demo: prints a banner, then echoes everything typed in the virtual
; terminal back in upper case. 9600 baud 8N1 at 16 MHz. Interrupt-driven RX.

.def tmp  = r16
.def ch   = r17

.org 0
        jmp reset
.org 0x24                       ; USART_RX (vector 18)
        jmp usart_rx
.org 0x34
reset:
        ldi tmp, high(RAMEND)
        out SPH, tmp
        ldi tmp, low(RAMEND)
        out SPL, tmp

        ldi tmp, 103            ; UBRR = 16e6 / (16 * 9600) - 1
        sts UBRR0L, tmp
        ldi tmp, (1<<RXEN0)|(1<<TXEN0)|(1<<RXCIE0)
        sts UCSR0B, tmp
        ldi tmp, (1<<UCSZ01)|(1<<UCSZ00)
        sts UCSR0C, tmp

        ldi ZL, low(banner*2)
        ldi ZH, high(banner*2)
        rcall puts
        sei
idle:
        rjmp idle

; RX complete: upper-case and echo; Enter prints a new prompt.
usart_rx:
        push tmp
        in tmp, SREG
        push tmp
        lds ch, UDR0
        cpi ch, 13
        brne not_cr
        ldi ZL, low(prompt*2)
        ldi ZH, high(prompt*2)
        rcall puts
        rjmp rx_done
not_cr:
        cpi ch, 'a'
        brlo send
        cpi ch, 'z'+1
        brsh send
        subi ch, 32
send:
        rcall putc
rx_done:
        pop tmp
        out SREG, tmp
        pop tmp
        reti

putc:                           ; transmit ch, waiting for an empty buffer
        lds tmp, UCSR0A
        sbrs tmp, UDRE0
        rjmp putc
        sts UDR0, ch
        ret

puts:                           ; transmit zero-terminated string at Z (flash)
        lpm ch, Z+
        tst ch
        breq puts_end
        rcall putc
        rjmp puts
puts_end:
        ret

banner: .db "Daedalus serial demo", 13, 10, "Type something:", 13, 10, "> ", 0
prompt: .db 13, 10, "> ", 0
