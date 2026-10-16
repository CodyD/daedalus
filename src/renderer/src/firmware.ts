// Resolves file-typed properties (MCU PROGRAM) before simulation starts:
//   "src:main.asm"  -> assemble the project's embedded source
//   "C:\...\x.asm"  -> read from disk and assemble
//   "C:\...\x.hex"  -> read Intel HEX from disk

import type { ComponentDef, Netlist } from "../../shared/component";
import type { Project } from "../../shared/project";
import { AsmError, assemble } from "../../sim/mcu/avr/asm";
import { M328P_SYMBOLS } from "../../sim/mcu/avr/variants";
import { toIntelHex } from "../../sim/mcu/hex";
import { api } from "./api";

export function assembleToHex(src: string): string {
  return toIntelHex(assemble(src, M328P_SYMBOLS).bytes);
}

export interface FirmwareProblem {
  ref: string;
  message: string;
  line?: number;
  source?: string;
}

export async function resolveFiles(
  netlist: Netlist,
  project: Project,
): Promise<{ netlist: Netlist; problems: FirmwareProblem[] }> {
  const problems: FirmwareProblem[] = [];
  const instances = await Promise.all(
    netlist.instances.map(async (inst) => {
      const files: Record<string, string> = {};
      for (const p of inst.def.properties) {
        if (p.kind !== "file") continue;
        const value = (inst.props[p.key] ?? p.default).trim();
        if (!value) continue;
        try {
          if (value.startsWith("src:")) {
            const name = value.slice(4);
            const src = project.sources?.[name];
            if (src === undefined) throw new Error(`project has no source file '${name}'`);
            try {
              files[p.key] = assembleToHex(src);
            } catch (e) {
              if (e instanceof AsmError) problems.push({ ref: inst.ref, message: e.message, line: e.line, source: name });
              else throw e;
            }
          } else {
            const text = await api().readFile(value);
            if (text === null) throw new Error(`file not found: ${value}`);
            files[p.key] = /\.(asm|s)$/i.test(value) ? assembleToHex(text) : text;
          }
        } catch (e) {
          problems.push({ ref: inst.ref, message: (e as Error).message });
        }
      }
      return { ...inst, files };
    }),
  );
  return { netlist: { ...netlist, instances }, problems };
}

export function isMcu(def: ComponentDef | undefined): boolean {
  return def?.model.kind === "mcu";
}
