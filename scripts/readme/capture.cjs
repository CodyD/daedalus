// Electron entry that takes the README screenshots. Started by build.ts with
// the renderer's dev server URL; drives the real UI (browser mode, or the
// scripted AI preload for the assistant and import shots) and writes PNGs.
//
//   electron scripts/readme/capture.cjs --url=http://localhost:5199 --out=docs/images [--only=hero,blink]

const { app, BrowserWindow } = require("electron");
const { mkdirSync, writeFileSync } = require("node:fs");
const { join, resolve } = require("node:path");

const arg = (k) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3);
const URL = arg("url");
const OUT = resolve(arg("out") ?? "docs/images");
const ROOT = resolve(arg("root") ?? ".");
const ONLY = arg("only")?.split(",");
const WIDTH = 1440;
const HEIGHT = 900;

app.commandLine.appendSwitch("force-device-scale-factor", "1");
app.commandLine.appendSwitch("disable-renderer-backgrounding");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Helpers installed in the page. Clicks go through element.click() or
// synthetic pointer/wheel events, which React handles like real input.
const PAGE_HELPERS = `
window.__rd = {
  find(text, sel) {
    const want = (el) => typeof text === "string" ? el.textContent.trim().startsWith(text) || el.getAttribute("aria-label") === text : text.test(el.textContent);
    return [...document.querySelectorAll(sel || "button,[role=menuitem],[role=tab]")].find((el) => want(el) && !el.disabled);
  },
  click(text, sel) {
    const el = this.find(text, sel);
    if (!el) throw new Error("no element: " + text);
    el.click();
  },
  type(sel, value) {
    const el = document.querySelector(sel);
    if (!el) throw new Error("no field: " + sel);
    const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value").set.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  },
  /** Pans and zooms the schematic so the whole circuit fills the sheet. */
  async fit(margin = 0.9) {
    // One event per rendered frame: the app computes each step from the view it last drew.
    const frame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const svg = document.querySelector(".canvas-wrap svg");
    const s = svg.getBoundingClientRect();
    // The hint line along the bottom of the sheet covers about 40px.
    const sheet = { l: s.left, t: s.top, w: s.width, h: s.height - 40 };
    const cx = sheet.l + sheet.w / 2, cy = sheet.t + sheet.h / 2;
    const bounds = () => {
      let box = null;
      for (const el of svg.children) {
        if (el.tagName === "defs" || el.getAttribute("fill") === "url(#grid5)") continue;
        const r = el.getBoundingClientRect();
        if (!r.width && !r.height) continue;
        box = box ? { l: Math.min(box.l, r.left), t: Math.min(box.t, r.top), r: Math.max(box.r, r.right), b: Math.max(box.b, r.bottom) }
          : { l: r.left, t: r.top, r: r.right, b: r.bottom };
      }
      return box;
    };
    const ptr = (type, x, y) => svg.dispatchEvent(new PointerEvent(type, { bubbles: true, button: 1, buttons: 4, pointerId: 1, clientX: x, clientY: y }));
    // Middle-drag pan: content centre to sheet centre.
    const centre = async () => {
      const b = bounds();
      ptr("pointerdown", (b.l + b.r) / 2, (b.t + b.b) / 2); await frame();
      ptr("pointermove", cx, cy); await frame();
      ptr("pointerup", cx, cy); await frame();
    };
    if (!bounds()) return;
    await centre();
    // Wheel zoom about the sheet centre, in the app's 1.15x steps.
    const b = bounds();
    const k = Math.min((sheet.w * margin) / (b.r - b.l), (sheet.h * margin) / (b.b - b.t));
    const steps = Math.floor(Math.log(k) / Math.log(1.15));
    for (let i = 0; i < Math.abs(steps); i++) {
      svg.dispatchEvent(new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: steps > 0 ? -100 : 100, clientX: cx, clientY: cy }));
      await frame();
    }
    await centre();
  },
};
0;`;

/**
 * Each shot: optional theme / a11y storage, the preload to use, and steps run
 * against the live page. `clip` is a CSS selector to crop to (default: window).
 */
const SHOTS = [
  {
    name: "hero", theme: "dark",
    steps: async (h) => { await h.example("03"); await h.fit(); await h.tab("CPU Registers"); await h.start(2.2); },
  },
  {
    name: "blink", theme: "light",
    steps: async (h) => { await h.example("01"); await h.fit(); await h.tab("Firmware"); await h.start(1.7, true) /* LED on from 1.5 s to 2 s */; },
  },
  {
    name: "serial", theme: "light",
    steps: async (h) => {
      await h.example("02"); await h.fit(); await h.tab("Virtual Terminal"); await h.start(0.5);
      await h.js(`__rd.type('input[aria-label^="Send to"]', "Hello from Daedalus"); document.querySelector('input[aria-label^="Send to"]').form.requestSubmit();`);
      await sleep(1200);
    },
  },
  {
    name: "dimmer", theme: "dark",
    steps: async (h) => { await h.example("04"); await h.fit(); await h.tab("Oscilloscope"); await h.start(1.5); },
  },
  {
    name: "chaser", theme: "light",
    steps: async (h) => { await h.example("05"); await h.fit(); await h.start(2.4); },
  },
  {
    name: "opamp", theme: "dark",
    steps: async (h) => { await h.example("06"); await h.fit(); await h.tab("Oscilloscope"); await h.start(1.2); },
  },
  {
    name: "assistant", theme: "dark", demo: true,
    steps: async (h) => {
      await h.tab("AI Assistant");
      await h.js(`__rd.type(".chat-input textarea", "An LED that lights while I hold a button down.")`);
      await h.js(`__rd.click("Send")`);
      await h.until(`!!__rd.find("Build") && /Spec complete/.test(document.body.textContent)`);
      await h.js(`__rd.click("Build")`);
      await h.until(`/Built and verified/.test(document.body.textContent) && !document.querySelector(".chat-busy")`, 30000);
      await h.fit();
      await sleep(400);
    },
  },
  {
    name: "import", theme: "light", demo: true,
    steps: async (h) => {
      await h.js(`__rd.click("Import Datasheet")`);
      await h.js(`__rd.click("Choose PDF…")`);
      await sleep(200);
      await h.js(`__rd.type('.dialog input[id$="-hint"]', "74HC165 in DIP-16"); __rd.click("Estimate cost")`);
      await sleep(300);
      await h.js(`__rd.click("Import with Claude")`);
      await sleep(1200);
    },
  },
  {
    name: "contrast", theme: "high-contrast", a11y: { zoom: 1, reduceMotion: true, colorSafe: true, announce: true },
    steps: async (h) => { await h.example("05"); await h.fit(); await h.start(2.4); },
  },
  {
    name: "options", theme: "light",
    steps: async (h) => {
      await h.example("04"); await h.fit();
      await h.js(`__rd.click("Options")`);
      await h.until(`!!document.querySelector("[role=dialog] [role=tab]")`);
      await h.js(`__rd.click("Accessibility", "[role=tab]")`);
      await sleep(300);
    },
  },
];

async function shoot(shot) {
  const win = new BrowserWindow({
    width: WIDTH, height: HEIGHT, useContentSize: true, show: false,
    webPreferences: {
      // A fresh in-memory partition per shot: no saved layout, theme or library leaks in.
      partition: `readme-${shot.name}-${Date.now()}`,
      // Hidden windows are throttled by default: timers slow down (so does the
      // simulation's real-time pacing) and frames stop being painted.
      backgroundThrottling: false,
      ...(shot.demo
        ? { preload: join(__dirname, "demo-api.cjs"), contextIsolation: false, sandbox: false, additionalArguments: [`--readme-root=${ROOT}`] }
        : {}),
    },
  });
  try {
    await capture(win, shot);
  } finally {
    win.destroy();
  }
}

async function capture(win, shot) {
  const wc = win.webContents;
  wc.on("console-message", (e) => { if (e.level === "error" || e.level === "warning") console.log(`    [${shot.name}] ${e.message}`); });
  const js = (code) => wc.executeJavaScript(`(async () => { ${code} })()`, true);

  await win.loadURL(URL);
  await js(`
    localStorage.clear();
    localStorage.setItem("daedalus.theme", ${JSON.stringify(shot.theme ?? "light")});
    ${shot.a11y ? `localStorage.setItem("daedalus.a11y", ${JSON.stringify(JSON.stringify(shot.a11y))});` : ""}
  `);
  await win.loadURL(URL);
  await wc.executeJavaScript(PAGE_HELPERS);

  const until = async (cond, ms = 10000) => {
    const end = Date.now() + ms;
    while (!(await js(`return ${cond}`))) {
      if (Date.now() > end) throw new Error(`${shot.name}: timed out waiting for ${cond}`);
      await sleep(100);
    }
  };
  await until(`!!document.querySelector(".canvas-wrap svg")`);

  const h = {
    js,
    until,
    example: async (prefix) => {
      await js(`__rd.click("File", "[role=menuitem],button")`);
      await sleep(100);
      await js(`__rd.click("Examples…")`);
      await until(`!!__rd.find(/^${prefix} /, ".dialog button")`);
      await js(`__rd.click(/^${prefix} /, ".dialog button")`);
      await sleep(300);
    },
    fit: async () => { await js(`await __rd.fit()`); await sleep(250); },
    tab: async (title) => { await js(`__rd.click(${JSON.stringify(title)}, "[role=tab]")`); await sleep(150); },
    /**
     * Starts the simulation and waits until it has simulated this many seconds
     * (status bar clock). `freeze` pauses there, for shots that must catch a
     * particular moment.
     */
    start: async (seconds, freeze = false) => {
      await js(`__rd.click("Start (F12)")`);
      await until(`parseFloat(document.querySelector(".statusbar .mono")?.textContent) >= ${seconds}`, 30000);
      if (freeze) await js(`__rd.click("Pause")`);
    },
  };

  await shot.steps(h);
  // Park the pointer-free UI: drop focus rings and hover state from the shot.
  await js(`document.activeElement?.blur?.()`);
  // Make sure the frame we capture is the current one, not the last one painted.
  wc.invalidate();
  await js(`await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))`);
  await sleep(150);
  const img = await wc.capturePage();
  writeFileSync(join(OUT, `${shot.name}.png`), img.toPNG());
  console.log(`  ${shot.name}.png  ${img.getSize().width}x${img.getSize().height}`);
}

// Shots open and close one window at a time; don't quit between them.
app.on("window-all-closed", () => {});

app.whenReady().then(async () => {
  if (!URL) throw new Error("--url is required");
  mkdirSync(OUT, { recursive: true });
  let failed = 0;
  for (const shot of SHOTS) {
    if (ONLY && !ONLY.includes(shot.name)) continue;
    try {
      await shoot(shot);
    } catch (e) {
      failed++;
      console.error(`  ${shot.name}: ${e.message}`);
    }
  }
  app.exit(failed ? 1 : 0);
});
