// One-shot worker for the assistant's verification runs, so a multi-second
// simulation never blocks the editor.

import type { Netlist } from "../../../shared/component";
import { HeadlessOptions, runHeadless } from "../../../sim/headless";

self.onmessage = (e: MessageEvent<{ netlist: Netlist; opts: HeadlessOptions }>) => {
  try {
    (self as unknown as Worker).postMessage({ ok: true, report: runHeadless(e.data.netlist, e.data.opts) });
  } catch (err) {
    (self as unknown as Worker).postMessage({ ok: false, error: (err as Error).message });
  }
};
