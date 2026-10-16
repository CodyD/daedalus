// Executes the design assistant's schematic tools against the live project.
// Pure dispatch over shared editing functions; UI prompts are injected.

import type { ComponentDef, Netlist } from "../../../shared/component";
import { EditError, connect, describeSchematic, disconnect, isTerminal, placePart, removePart, setProperty } from "../../../shared/edit";
import { Project, buildNetlist } from "../../../shared/project";
import type { Rotation } from "../../../shared/symbols";
import type { HeadlessOptions, runHeadless } from "../../../sim/headless";
import { AsmError, assemble } from "../../../sim/mcu/avr/asm";
import { EMU_CTRL_BASE, EMU_DAC_BASE, EMU_RAM, assembleEmulator } from "../../../sim/mcu/avr/emulator";
import { validateComponent } from "../../../sim/validate";
import { M328P_SYMBOLS } from "../../../sim/mcu/avr/variants";

export interface ExecContext {
  getProject(): Project;
  setProject(p: Project): void;
  defs(): Map<string, ComponentDef>;
  resolveFiles(netlist: Netlist, project: Project): Promise<{ netlist: Netlist; problems: { ref: string; message: string }[] }>;
  simulate(netlist: Netlist, opts: HeadlessOptions): Promise<ReturnType<typeof runHeadless>>;
  askApproval(input: ApprovalRequest): Promise<boolean>;
  askFile(input: { part_number: string; reason: string }): Promise<string | null>;
  libraryChanged(): Promise<void>;
  /** Save a part to the user's library (and refresh the library). */
  savePart(def: ComponentDef): Promise<void>;
}

export interface ApprovalRequest {
  part_number: string;
  url: string;
  reason: string;
  pages: number;
  cost_usd: number;
  /** True when the import runs on the user's Claude Code plan. */
  subscription?: boolean;
}

function partSummary(def: ComponentDef, full: boolean) {
  const base = {
    id: def.id,
    name: def.name,
    category: def.category,
    model: def.model.kind === "mcu" ? `mcu:${def.model.mcu?.core}` : def.model.kind,
    description: def.description,
  };
  if (!full) return base;
  return {
    ...base,
    manufacturer: def.manufacturer,
    pins: def.pins.map((p) => ({ id: p.id, name: p.name, number: p.number, type: p.type, port: p.port, functions: p.functions })),
    properties: def.properties.map((p) => ({ key: p.key, default: p.default, unit: p.unit, kind: p.kind })),
    electrical: def.electrical,
    notes: def.source?.notes,
  };
}

function searchLibrary(defs: Map<string, ComponentDef>, query: string) {
  const all = [...defs.values()].filter((d) => !isTerminal(d.id));
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const hits = words.length
    ? all.filter((d) => {
      const hay = `${d.id} ${d.name} ${d.description} ${d.manufacturer ?? ""} ${d.category}`.toLowerCase();
      return words.every((w) => hay.includes(w));
    })
    : all;
  return {
    summary: `${hits.length} match${hits.length === 1 ? "" : "es"} for "${query}"`,
    parts: hits.slice(0, 40).map((d) => partSummary(d, false)),
    note: "Supply rails, ground and net labels are added automatically by connect.",
  };
}

const ROT: Record<string, Rotation> = { "0": 0, "90": 90, "180": 180, "270": 270 };

export async function executeTool(name: string, input: any, ctx: ExecContext): Promise<unknown> {
  const defs = ctx.defs();
  try {
    switch (name) {
      case "search_library":
        return searchLibrary(defs, String(input.query ?? ""));
      case "get_part": {
        const def = defs.get(input.id);
        if (!def) return { error: `unknown part id '${input.id}'` };
        return { summary: `${def.id}: ${def.pins.length} pins`, ...partSummary(def, true) };
      }
      case "get_schematic": {
        const d = describeSchematic(ctx.getProject(), defs);
        return { summary: `${d.parts.length} parts, ${d.nets.length} nets`, ...d };
      }
      case "place_part": {
        const r = placePart(ctx.getProject(), defs, {
          defId: input.def_id, ref: input.ref, props: input.props, x: input.x, y: input.y,
          rot: input.rotation ? ROT[input.rotation] : undefined,
        });
        ctx.setProject(r.project);
        const def = defs.get(input.def_id)!;
        return { summary: `placed ${r.ref} (${def.name})`, ref: r.ref, pins: def.pins.map((p) => `${r.ref}.${p.id}`) };
      }
      case "connect": {
        const r = connect(ctx.getProject(), defs, input.net, input.pins, input.rail_voltage);
        ctx.setProject(r.project);
        return {
          summary: `${input.net}: ${r.connected.join(", ") || "nothing new"}`,
          net: input.net, connected: r.connected, already_on_net: r.skipped.length ? r.skipped : undefined,
        };
      }
      case "disconnect":
        ctx.setProject(disconnect(ctx.getProject(), defs, input.pins));
        return { summary: `disconnected ${input.pins.join(", ")}` };
      case "remove_part":
        ctx.setProject(removePart(ctx.getProject(), defs, input.ref));
        return { summary: `removed ${input.ref}` };
      case "set_property":
        ctx.setProject(setProperty(ctx.getProject(), defs, input.ref, input.key, input.value));
        return { summary: `${input.ref}.${input.key} = ${input.value}` };
      case "write_firmware": {
        const p = ctx.getProject();
        const mcu = p.parts.find((x) => x.ref === input.mcu_ref);
        const def = mcu && defs.get(mcu.defId);
        if (!mcu || !def) return { error: `no part '${input.mcu_ref}'` };
        if (def.model.kind !== "mcu" || def.model.mcu?.core !== "avr8") return { error: `${input.mcu_ref} is not an AVR microcontroller` };
        const filename = String(input.filename).replace(/[^\w.-]/g, "_");
        const withSource: Project = {
          ...p,
          sources: { ...(p.sources ?? {}), [filename]: input.source },
          parts: p.parts.map((x) => (x.ref === mcu.ref ? { ...x, props: { ...x.props, PROGRAM: `src:${filename}` } } : x)),
        };
        ctx.setProject(withSource);
        try {
          const r = assemble(input.source, M328P_SYMBOLS);
          return { summary: `${filename}: ${r.bytes.length} bytes`, bytes: r.bytes.length, program: `src:${filename}` };
        } catch (e) {
          if (e instanceof AsmError) {
            const line = String(input.source).split(/\r?\n/)[e.line - 1] ?? "";
            return { error: e.message, line: e.line, source_line: line.trim(), note: "Source saved; fix and call write_firmware again." };
          }
          throw e;
        }
      }
      case "run_simulation": {
        const project = ctx.getProject();
        const { netlist } = buildNetlist(project, defs);
        if (!netlist.instances.length) return { error: "schematic is empty" };
        const { netlist: resolved, problems } = await ctx.resolveFiles(netlist, project);
        if (problems.length) return { error: "firmware problems", problems };
        const report = await ctx.simulate(resolved, { seconds: input.seconds, actions: input.actions, watch: input.watch });
        const lit = Object.entries(report.indicators).filter(([, v]) => (v as { lit?: boolean }).lit).map(([k]) => k);
        return { summary: `${report.simulated_seconds} s simulated${report.warnings.length ? `, ${report.warnings.length} warnings` : ""}${lit.length ? `, lit: ${lit.join(" ")}` : ""}`, ...report };
      }
      case "define_emulated_part":
        return await defineEmulatedPart(input, defs, ctx);
      case "approve_import":
        return { approved: await ctx.askApproval(input as ApprovalRequest) };
      case "request_file":
        return { path: await ctx.askFile(input) };
      case "library_changed":
        await ctx.libraryChanged();
        return { ok: true };
    }
    return { error: `unknown tool '${name}'` };
  } catch (e) {
    if (e instanceof EditError) return { error: e.message };
    return { error: (e as Error).message };
  }
}

/** Creates or replaces an emulated part: a sensor or module backed by a hidden AVR running emulator firmware. */
async function defineEmulatedPart(input: any, defs: Map<string, ComponentDef>, ctx: ExecContext) {
  const id = String(input.id ?? "").trim();
  const existing = defs.get(id);
  if (existing && existing.model.kind !== "emulator") {
    return { error: `'${id}' is already a ${existing.source?.kind === "datasheet" ? "datasheet-imported" : "built-in"} part; choose another id (e.g. ${id}_EMU)` };
  }
  const def: ComponentDef = {
    id,
    name: input.name,
    category: input.category ?? "peripheral",
    description: input.description,
    manufacturer: input.manufacturer,
    refPrefix: input.ref_prefix ?? "U",
    pins: (input.pins ?? []).map((p: any) => ({
      id: p.id, name: p.name, number: String(p.number), type: p.type, side: p.side, port: p.backing || undefined,
    })),
    properties: [],
    symbol: { kind: "box" },
    model: {
      kind: "emulator",
      emulator: { core: "avr8", clockHz: input.clock_hz ?? 16e6, source: String(input.firmware ?? ""), controls: input.controls ?? [] },
    },
    source: { kind: "emulated", importedAt: new Date().toISOString(), notes: input.notes },
  };
  // Assembler errors first, with the offending line, the way write_firmware reports them.
  try {
    if (def.model.emulator!.controls.every((c) => typeof c?.key === "string")) assembleEmulator(def.model.emulator!);
  } catch (e) {
    if (e instanceof AsmError) {
      const line = def.model.emulator!.source.split(/\r?\n/)[e.line - 1] ?? "";
      return { error: `firmware: ${e.message}`, line: e.line, source_line: line.trim(), note: "Nothing was saved; fix and call define_emulated_part again." };
    }
  }
  const check = validateComponent(def);
  if (check.errors.length) return { error: `${id} is not valid`, details: check.errors, note: "Nothing was saved; fix and call again." };
  await ctx.savePart(def);
  return {
    summary: `${existing ? "updated" : "created"} emulated part ${id}`,
    id,
    pins: def.pins.map((p) => `${p.id}${p.port ? `=${p.port}` : ""}`),
    controls: def.model.emulator!.controls.map((c, i) => `CTRL_${c.key} @ 0x${(EMU_CTRL_BASE + 4 * i).toString(16)}`),
    dacs: `DAC0..DAC3 @ 0x${EMU_DAC_BASE.toString(16)}, firmware RAM from 0x${EMU_RAM.toString(16)}`,
    warnings: check.warnings.length ? check.warnings : undefined,
    next: existing ? "Placed copies use the new definition on the next simulation run." : "Place it with place_part.",
  };
}
