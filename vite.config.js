import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import fs from "node:fs";
import crypto from "node:crypto";

/** Writes dist/sw.js with this build's file list, so the installed app can open with no internet. */
function serviceWorker() {
  return {
    name: "bladeos-service-worker",
    apply: "build",
    generateBundle(_, bundle) {
      const pub = ["/manifest.webmanifest", "/favicon.svg", "/icons/icon-192.png", "/icons/icon-512.png", "/icons/maskable-512.png", "/icons/apple-touch-icon.png"];
      const files = [...Object.keys(bundle).filter((f) => !f.endsWith(".map") && f !== "index.html").map((f) => "/" + f), ...pub];
      const version = crypto.createHash("sha256").update(files.sort().join("|") + Date.now()).digest("hex").slice(0, 12);
      const src = fs.readFileSync("src/sw-template.js", "utf8").replace("__VERSION__", version).replace("__ASSETS__", JSON.stringify(files));
      this.emitFile({ type: "asset", fileName: "sw.js", source: src });
    },
  };
}

export default defineConfig({
  plugins: [react(), serviceWorker()],
  server: {
    proxy: { "/api": "http://localhost:3000", "/health": "http://localhost:3000" },
  },
  build: {
    outDir: "dist",
    sourcemap: false,
    chunkSizeWarningLimit: 700,
    rollupOptions: {
      output: {
        manualChunks: { icons: ["lucide-react"] }, // charts split off on their own with the screens that use them
      },
    },
  },
});
