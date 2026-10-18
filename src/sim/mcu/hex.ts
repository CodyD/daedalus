// Intel HEX loader (the format Arduino IDE, avr-gcc and MPLAB all use
// for the microcontroller "Program File" property).

export function parseIntelHex(text: string): Uint8Array {
  const chunks: [number, number[]][] = [];
  let base = 0;
  let max = 0;
  const lines = text.split(/\r?\n/);
  for (let ln = 0; ln < lines.length; ln++) {
    const line = lines[ln].trim();
    if (!line) continue;
    if (line[0] !== ":") throw new Error(`HEX line ${ln + 1}: missing ':'`);
    const bytes: number[] = [];
    for (let i = 1; i + 1 < line.length; i += 2) bytes.push(parseInt(line.slice(i, i + 2), 16));
    const sum = bytes.reduce((a, b) => a + b, 0) & 0xff;
    if (sum !== 0) throw new Error(`HEX line ${ln + 1}: bad checksum`);
    const [len, ah, al, type] = bytes;
    const data = bytes.slice(4, 4 + len);
    const addr = (ah << 8) | al;
    switch (type) {
      case 0x00:
        chunks.push([base + addr, data]);
        max = Math.max(max, base + addr + len);
        break;
      case 0x01:
        ln = lines.length;
        break;
      case 0x02:
        base = ((data[0] << 8) | data[1]) << 4;
        break;
      case 0x04:
        base = ((data[0] << 8) | data[1]) << 16;
        break;
      default:
        break; // 03/05 start address records are irrelevant here
    }
  }
  const out = new Uint8Array(max).fill(0xff);
  for (const [a, d] of chunks) out.set(d, a);
  return out;
}

export function toIntelHex(bytes: Uint8Array): string {
  const lines: string[] = [];
  const rec = (addr: number, type: number, data: number[]) => {
    const b = [data.length, (addr >> 8) & 0xff, addr & 0xff, type, ...data];
    const sum = (-b.reduce((a, x) => a + x, 0)) & 0xff;
    lines.push(":" + [...b, sum].map((x) => x.toString(16).padStart(2, "0").toUpperCase()).join(""));
  };
  for (let a = 0; a < bytes.length; a += 16) {
    if (a > 0 && a % 0x10000 === 0) rec(0, 4, [(a >> 24) & 0xff, (a >> 16) & 0xff]);
    rec(a & 0xffff, 0, Array.from(bytes.subarray(a, a + 16)));
  }
  rec(0, 1, []);
  return lines.join("\n") + "\n";
}
