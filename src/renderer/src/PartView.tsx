import type { ComponentDef } from "../../shared/component";
import type { PartInstance } from "../../shared/project";
import { SymPin, SymbolGeom } from "../../shared/symbols";
import { formatValue, parseValue } from "../../sim/units";
import { lcdGlyph } from "./lcdfont";

const DIRV: Record<SymPin["dir"], [number, number]> = { left: [-1, 0], right: [1, 0], up: [0, -1], down: [0, 1] };

interface Props {
  part: PartInstance;
  def: ComponentDef;
  geom: SymbolGeom;
  selected: boolean;
  indicate?: unknown;
  onPointerDown?: (e: React.PointerEvent) => void;
  onPointerEnter?: () => void;
  onPointerLeave?: () => void;
  onActuate?: (action: Record<string, unknown>) => void;
  /** Emulated parts: open the backing simulator's controls. */
  onEmulator?: () => void;
  simulating: boolean;
}

const LED_COLORS: Record<string, string> = {
  red: "#ff2a1a", green: "#20e050", yellow: "#ffd51a", blue: "#2a8cff", white: "#ffffff", orange: "#ff8a00",
};

export function valueLabel(part: PartInstance, def: ComponentDef): string {
  const main = def.properties.find((p) => ["R", "C", "L", "VOLTAGE", "FREQ"].includes(p.key));
  if (!main) return def.symbol.kind === "box" ? def.name.split(" ")[0] : "";
  const raw = part.props[main.key] ?? main.default;
  const v = parseValue(raw);
  return isFinite(v) ? formatValue(v, main.unit ?? "") : raw;
}

export function PartView({ part, def, geom, selected, indicate, onPointerDown, onPointerEnter, onPointerLeave, onActuate, onEmulator, simulating }: Props) {
  const ind = (indicate ?? {}) as Record<string, any>;
  const sx = part.mirror ? -1 : 1;
  const k = geom.kind;
  const pinLines = geom.pins.map((p) => {
    const [dx, dy] = DIRV[p.dir];
    return <line key={p.id} className="pin-line" x1={p.x} y1={p.y} x2={p.x - dx * p.len} y2={p.y - dy * p.len} />;
  });

  let body: React.ReactNode;
  switch (k) {
    case "resistor":
      body = <><rect className="sym-fill" x={-20} y={-6} width={40} height={12} /><line className="sym-line" x1={-30} y1={0} x2={-20} y2={0} /><line className="sym-line" x1={20} y1={0} x2={30} y2={0} /></>;
      break;
    case "pot": {
      const pos = typeof ind.position === "number" ? ind.position : parseValue(part.props.POSITION ?? "0.5");
      const wx = -20 + 40 * pos;
      body = <>
        <rect className="sym-fill" x={-20} y={-6} width={40} height={12} />
        <line className="sym-line" x1={-30} y1={0} x2={-20} y2={0} /><line className="sym-line" x1={20} y1={0} x2={30} y2={0} />
        <polyline className="sym-line" points={`0,-20 ${wx},-20 ${wx},-8`} />
        <path d={`M${wx - 3},-12 L${wx},-7 L${wx + 3},-12 Z`} fill="var(--ink)" />
      </>;
      break;
    }
    case "capacitor":
    case "capacitor-polar":
      body = <>
        <line className="sym-line" x1={-30} y1={0} x2={-4} y2={0} /><line className="sym-line" x1={4} y1={0} x2={30} y2={0} />
        <line className="sym-line" x1={-4} y1={-12} x2={-4} y2={12} />
        {k === "capacitor" ? <line className="sym-line" x1={4} y1={-12} x2={4} y2={12} /> : <path className="sym-line" d="M8,-12 Q3,0 8,12" />}
        {k === "capacitor-polar" && <text className="sym-text" x={-14} y={-6}>+</text>}
      </>;
      break;
    case "inductor":
      body = <path className="sym-line" d="M-30,0 L-20,0 a5,5 0 0 1 10,0 a5,5 0 0 1 10,0 a5,5 0 0 1 10,0 a5,5 0 0 1 10,0 L30,0" />;
      break;
    case "diode":
    case "zener":
    case "led": {
      const glow = k === "led" ? Math.max(0, Math.min(1, Number(ind.brightness ?? 0))) : 0;
      const col = LED_COLORS[(part.props.COLOR ?? def.properties.find((p) => p.key === "COLOR")?.default ?? "red").toLowerCase()] ?? "#ff2a1a";
      body = <>
        {k === "led" && glow > 0.02 && <circle cx={0} cy={0} r={18} fill={col} opacity={0.15 + 0.6 * glow} />}
        <line className="sym-line" x1={-20} y1={0} x2={-8} y2={0} /><line className="sym-line" x1={8} y1={0} x2={20} y2={0} />
        <path d="M-8,-9 L-8,9 L8,0 Z" fill={k === "led" && glow > 0.02 ? col : "var(--sym-bg)"} stroke={ind.overloaded ? "var(--err)" : "var(--ink)"} strokeWidth={1.6} />
        {k === "zener" ? <polyline className="sym-line" points="4,-12 8,-9 8,9 12,12" /> : <line className="sym-line" x1={8} y1={-9} x2={8} y2={9} />}
        {k === "led" && <path className="sym-line" d="M2,-12 l6,-7 m-3,0 l3,0 l0,3 M9,-10 l6,-7 m-3,0 l3,0 l0,3" />}
      </>;
      break;
    }
    case "button":
    case "switch": {
      const closed = !!ind.closed;
      const act = (down: boolean) => (e: React.PointerEvent) => {
        if (!simulating) return;
        e.stopPropagation();
        if (k === "button") onActuate?.({ pressed: down });
        else if (down) onActuate?.({});
      };
      body = <g onPointerDown={act(true)} onPointerUp={act(false)} onPointerLeave={k === "button" && closed ? act(false) : undefined} style={{ cursor: simulating ? "pointer" : undefined }}>
        <rect x={-30} y={-22} width={60} height={34} fill="transparent" />
        <line className="sym-line" x1={-30} y1={0} x2={-18} y2={0} /><line className="sym-line" x1={18} y1={0} x2={30} y2={0} />
        <circle cx={-16} cy={0} r={2} fill="var(--ink)" /><circle cx={16} cy={0} r={2} fill="var(--ink)" />
        {k === "button"
          ? <><line className="sym-line" x1={-18} y1={closed ? -2 : -9} x2={18} y2={closed ? -2 : -9} /><line className="sym-line" x1={0} y1={closed ? -2 : -9} x2={0} y2={closed ? -12 : -19} /></>
          : <line className="sym-line" x1={-16} y1={0} x2={closed ? 16 : 13} y2={closed ? -2 : -14} />}
      </g>;
      break;
    }
    case "battery":
      body = <>
        <line className="sym-line" x1={0} y1={-30} x2={0} y2={-6} /><line className="sym-line" x1={0} y1={6} x2={0} y2={30} />
        <line className="sym-line" x1={-14} y1={-6} x2={14} y2={-6} /><line className="sym-line" x1={-7} y1={0} x2={7} y2={0} strokeWidth={3} />
        <line className="sym-line" x1={-14} y1={6} x2={14} y2={6} /><text className="sym-text" x={10} y={-12}>+</text>
      </>;
      break;
    case "vsource":
      body = <>
        <line className="sym-line" x1={0} y1={-30} x2={0} y2={-16} /><line className="sym-line" x1={0} y1={16} x2={0} y2={30} />
        <circle className="sym-fill" r={16} />
        {def.id === "VPULSE" ? <polyline className="sym-line" points="-9,5 -9,-5 0,-5 0,5 9,5 9,-5" /> : <path className="sym-line" d="M-10,0 Q-5,-10 0,0 T10,0" />}
      </>;
      break;
    case "ground":
      body = <><rect x={-14} y={-12} width={28} height={26} fill="transparent" /><line className="sym-line" x1={0} y1={-10} x2={0} y2={0} /><line className="sym-line" x1={-12} y1={0} x2={12} y2={0} /><line className="sym-line" x1={-7} y1={5} x2={7} y2={5} /><line className="sym-line" x1={-2} y1={10} x2={2} y2={10} /></>;
      break;
    case "power": {
      const net = part.props.NET || "VCC";
      body = <><rect x={-12} y={-14} width={24} height={26} fill="transparent" /><line className="sym-line" x1={0} y1={10} x2={0} y2={-4} /><path className="sym-line" d="M-8,-4 L0,-12 L8,-4" />
        <text className="sym-text" x={0} y={-16} textAnchor="middle" transform={upright(part, 0, -19)}>{net} {part.props.VOLTAGE ?? "5"}V</text></>;
      break;
    }
    case "label": {
      const name = part.props.NAME || "NET1";
      const w = name.length * 7 + 12;
      const cx = (w - 4) / 2;
      body = <><path className="sym-fill" d={`M-10,0 L-4,-8 L${w},-8 L${w},8 L-4,8 Z`} />
        <text className="sym-text" x={cx} y={4} textAnchor="middle" transform={upright(part, cx, 0)}>{name}</text></>;
      break;
    }
    case "npn":
    case "pnp":
    case "nmos": {
      body = k === "nmos"
        ? <><circle className="sym-fill" r={20} /><line className="sym-line" x1={-20} y1={0} x2={-6} y2={0} /><line className="sym-line" x1={-6} y1={-10} x2={-6} y2={10} />
            <line className="sym-line" x1={-1} y1={-12} x2={-1} y2={-6} /><line className="sym-line" x1={-1} y1={-3} x2={-1} y2={3} /><line className="sym-line" x1={-1} y1={6} x2={-1} y2={12} />
            <polyline className="sym-line" points="-1,-9 10,-9 10,-20" /><polyline className="sym-line" points="-1,9 10,9 10,20" /><polyline className="sym-line" points="-1,0 10,0 10,9" />
            <path d="M2,0 l5,-3 l0,6 Z" fill="var(--ink)" /></>
        : <><circle className="sym-fill" r={20} /><line className="sym-line" x1={-20} y1={0} x2={-5} y2={0} /><line className="sym-line" x1={-5} y1={-11} x2={-5} y2={11} />
            <line className="sym-line" x1={-5} y1={-5} x2={10} y2={-20} /><line className="sym-line" x1={-5} y1={5} x2={10} y2={20} />
            {k === "npn" ? <path d="M10,20 l-8,-3 l4,-4 Z" fill="var(--ink)" /> : <path d="M-5,-5 l8,-1 l-3,-5 Z" fill="var(--ink)" />}</>;
      break;
    }
    case "opamp":
      body = <>
        <path className="sym-fill" d="M-30,-30 L-30,30 L30,0 Z" />
        <line className="sym-line" x1={-30} y1={-10} x2={-40} y2={-10} /><line className="sym-line" x1={-30} y1={10} x2={-40} y2={10} />
        <text className="sym-text" x={-26} y={-6}>−</text><text className="sym-text" x={-26} y={14}>+</text>
        <line className="sym-line" x1={0} y1={-15} x2={0} y2={-20} /><line className="sym-line" x1={0} y1={15} x2={0} y2={20} />
      </>;
      break;
    case "clock":
      body = <><rect className="sym-fill" x={-20} y={-15} width={40} height={30} /><polyline className="sym-line" points="-14,6 -14,-6 -4,-6 -4,6 6,6 6,-6 14,-6" /></>;
      break;
    case "logicstate": {
      const on = Number(ind.level ?? parseValue(part.props.STATE ?? "0")) === 1;
      body = <g onPointerDown={(e) => { if (simulating) { e.stopPropagation(); onActuate?.({}); } }} style={{ cursor: simulating ? "pointer" : undefined }}>
        <rect x={-15} y={-15} width={30} height={30} fill={on ? "var(--high)" : "var(--low)"} stroke="var(--ink)" strokeWidth={1.6} />
        <text x={0} y={5} textAnchor="middle" fill="#fff" fontWeight={700}>{on ? 1 : 0}</text>
      </g>;
      break;
    }
    case "logicprobe": {
      const l = ind.level as number | undefined;
      const fill = l === 1 ? "var(--high)" : l === 0 ? "var(--low)" : l === 3 ? "var(--conflict)" : "var(--float)";
      body = <><circle cx={0} cy={0} r={14} fill={fill} stroke="var(--ink)" strokeWidth={1.6} />
        <text x={0} y={4} textAnchor="middle" fill="#fff" fontWeight={700}>{l === 1 ? "1" : l === 0 ? "0" : l === 3 ? "X" : "?"}</text></>;
      break;
    }
    case "vterm":
      body = <><rect className="sym-fill" x={-40} y={-30} width={80} height={60} rx={4} /><rect x={-32} y={-22} width={64} height={30} fill="#012456" />
        <text x={0} y={-3} textAnchor="middle" fill="#fff" fontSize={9} fontFamily="var(--mono)">TERMINAL</text>
        <text className="pin-name" x={-36} y={-7}>RXD</text><text className="pin-name" x={-36} y={22}>TXD</text></>;
      break;
    case "lcd":
      body = <LcdBody ind={ind} rows={Number(part.props.ROWS ?? 2)} cols={Number(part.props.COLS ?? 16)} geom={geom} />;
      break;
    case "sevenseg":
      body = <SevenSegBody mask={Number(ind.segments ?? 0)} />;
      break;
    case "voltmeter":
    case "ammeter": {
      const v = typeof ind.value === "number" ? formatValue(ind.value, ind.unit) : k === "voltmeter" ? "--- V" : "--- A";
      body = <><rect className="sym-fill" x={-30} y={-25} width={60} height={50} rx={6} /><rect x={-24} y={-12} width={48} height={20} fill="#0b2a12" />
        <text x={0} y={3} textAnchor="middle" fill="#6dff8f" fontFamily="var(--mono)" fontSize={11}>{v}</text>
        <text className="sym-text" x={0} y={20} textAnchor="middle">{k === "voltmeter" ? "VOLTS" : "AMPS"}</text>
        <text className="sym-text" x={-26} y={-15}>+</text></>;
      break;
    }
    case "scope":
      body = <><rect className="sym-fill" x={-40} y={-50} width={80} height={100} rx={4} /><rect x={-32} y={-42} width={64} height={44} fill="#06122b" />
        <path d="M-30,-18 q8,-18 16,0 t16,0 t16,0 t12,-6" stroke="#ffd34d" fill="none" strokeWidth={1.2} />
        {["A", "B", "C", "D"].map((c, i) => <text key={c} className="pin-name" x={-36} y={-27 + i * 20}>{c}</text>)}</>;
      break;
    default:
      body = <BoxBody geom={geom} def={def} ind={ind} />;
  }

  const labelY = k === "box" ? -geom.h / 2 - 26 : -geom.h / 2 - 6;
  const showVal = !["ground", "power", "label"].includes(k);
  return (
    <g className={`part${selected ? " sel" : ""}`} transform={`translate(${part.x},${part.y})`}
      onPointerDown={onPointerDown} onPointerEnter={onPointerEnter} onPointerLeave={onPointerLeave}>
      <g transform={`rotate(${part.rot}) scale(${sx},1)`}>
        {pinLines}
        {body}
      </g>
      {showVal && <text className="sym-ref" x={k === "box" ? -geom.w / 2 : -geom.w / 2} y={labelY}>{part.ref}</text>}
      {showVal && <text className="sym-val" x={k === "box" ? -geom.w / 2 + part.ref.length * 7 + 6 : -geom.w / 2} y={k === "box" ? labelY : geom.h / 2 + 14}>{valueLabel(part, def)}</text>}
      {def.model.kind === "emulator" && onEmulator && (
        <g className="emu-btn" transform={`translate(${geom.w / 2 - 30},${-geom.h / 2 - 17})`}
          onPointerDown={(e) => e.stopPropagation()} onClick={(e) => { e.stopPropagation(); onEmulator(); }}>
          <title>Sensor emulator: set the readings this part reports</title>
          <rect width={30} height={14} rx={2} />
          <path d="M5,10 l3,-5 l3,3 l3,-5" />
          <text x={18} y={10.5}>SIM</text>
        </g>
      )}
    </g>
  );
}

/** Counter-rotate text on upside-down terminals so it stays readable. */
function upright(part: PartInstance, cx: number, cy: number): string | undefined {
  return part.rot === 180 ? `rotate(180 ${cx} ${cy})` : undefined;
}

function BoxBody({ geom, def, ind }: { geom: SymbolGeom; def: ComponentDef; ind: Record<string, any> }) {
  const { w, h } = geom;
  return (
    <>
      <rect className="sym-fill" x={-w / 2} y={-h / 2} width={w} height={h} fill={(def.model.kind === "mcu" || def.model.kind === "emulator") && ind.loaded ? "var(--sym-bg-active)" : "var(--sym-bg)"} />
      {geom.pins.map((p) => {
        const inside = p.dir === "left" ? [p.x + p.len + 4, p.y + 3, "start"] : p.dir === "right" ? [p.x - p.len - 4, p.y + 3, "end"]
          : p.dir === "up" ? [p.x, p.y + p.len + 10, "middle"] : [p.x, p.y - p.len - 4, "middle"];
        const num = p.dir === "left" || p.dir === "right"
          ? [p.x + (p.dir === "left" ? 6 : -6), p.y - 3, p.dir === "left" ? "start" : "end"]
          : [p.x + 3, p.y + (p.dir === "up" ? 8 : -6), "start"];
        const over = p.name.startsWith("~");
        const label = over ? p.name.slice(1) : p.name;
        return (
          <g key={p.id}>
            <text className="pin-name" x={inside[0] as number} y={inside[1] as number} textAnchor={inside[2] as "start" | "middle" | "end"}
              textDecoration={over ? "overline" : undefined}>{label}</text>
            <text className="pin-num" x={num[0] as number} y={num[1] as number} textAnchor={num[2] as "start" | "middle" | "end"}>{p.number}</text>
          </g>
        );
      })}
      <text className="sym-text" x={0} y={0} textAnchor="middle" opacity={0.35} fontSize={11}>{def.name.split(" ")[0]}</text>
    </>
  );
}

function LcdBody({ ind, rows, cols, geom }: { ind: Record<string, any>; rows: number; cols: number; geom: SymbolGeom }) {
  const { w, h } = geom;
  const cw = Math.min(9, (w - 24) / cols);
  const ch = 16;
  const lines: number[][] = ind.lines ?? [];
  const cg: number[] = ind.cgram ?? [];
  const on = !!ind.on;
  const px = cw / 6;
  const glyphs: React.ReactNode[] = [];
  if (on) {
    lines.forEach((row, r) => row.forEach((code, c) => {
      const rowsBits = code < 8 ? cg.slice(code * 8, code * 8 + 8) : lcdGlyph(code);
      const ox = -w / 2 + 12 + c * cw;
      const oy = -h / 2 + 18 + r * (ch + 4);
      rowsBits.forEach((bits, y) => {
        for (let x = 0; x < 5; x++) {
          if (bits & (0x10 >> x)) glyphs.push(<rect key={`${r}-${c}-${y}-${x}`} x={ox + x * px} y={oy + y * 2} width={px * 0.9} height={1.8} fill="#1b2a10" />);
        }
      });
      if (ind.cursor && ind.cursor.row === r && ind.cursor.col === c) glyphs.push(<rect key={`cur${r}${c}`} x={ox} y={oy + 14} width={5 * px} height={1.6} fill="#1b2a10" />);
    }));
  }
  return (
    <>
      <rect x={-w / 2} y={-h / 2} width={w} height={h} rx={4} fill="#3c4a2a" stroke="var(--ink)" strokeWidth={1.6} />
      <rect x={-w / 2 + 6} y={-h / 2 + 8} width={w - 12} height={rows * (ch + 4) + 12} fill={on ? "#9ccf3a" : "#7f9d47"} />
      {glyphs}
      {geom.pins.map((p) => (
        <text key={p.id} className="pin-num" transform={`translate(${p.x + 3},${h / 2 - 3}) rotate(-90)`} style={{ fill: "#e7f3c4" }}>{p.name}</text>
      ))}
    </>
  );
}

const SEG_PATHS = [
  "M-14,-34 L14,-34 L10,-30 L-10,-30 Z", // a
  "M16,-32 L16,-2 L12,-5 L12,-28 Z", // b
  "M16,2 L16,32 L12,28 L12,5 Z", // c
  "M-14,34 L14,34 L10,30 L-10,30 Z", // d
  "M-16,2 L-16,32 L-12,28 L-12,5 Z", // e
  "M-16,-32 L-16,-2 L-12,-5 L-12,-28 Z", // f
  "M-14,0 L-10,-3 L10,-3 L14,0 L10,3 L-10,3 Z", // g
];

function SevenSegBody({ mask }: { mask: number }) {
  return (
    <>
      <rect x={-45} y={-50} width={90} height={100} rx={4} fill="#1a1a1a" stroke="var(--ink)" strokeWidth={1.6} />
      <g transform="skewX(-6)">
        {SEG_PATHS.map((d, i) => <path key={i} d={d} fill={mask & (1 << i) ? "#ff2a1a" : "#3a1512"} />)}
        <circle cx={24} cy={33} r={3} fill={mask & 0x80 ? "#ff2a1a" : "#3a1512"} />
      </g>
    </>
  );
}
