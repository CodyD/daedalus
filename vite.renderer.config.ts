// Browser-only preview of the renderer (no Electron): `npx vite --config vite.renderer.config.ts`
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  root: "src/renderer",
  plugins: [react()],
  worker: { format: "es" },
  server: { port: 5199, fs: { allow: ["../.."] } },
});
