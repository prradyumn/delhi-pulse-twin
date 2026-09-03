import { defineConfig } from "vite";
// @ts-expect-error - plain .mjs plugin, no types needed for a 70-line middleware
import { otdVehicles } from "./vite-otd.mjs";

export default defineConfig(({ mode }) => ({
  base: "./",
  // The repo root holds .env.local, one level above web/, so Vite is told where to look.
  envDir: "..",
  plugins: [otdVehicles({ root: "..", mode })],
  build: { target: "es2022", assetsInlineLimit: 0, sourcemap: false,
           rollupOptions: { output: { manualChunks: { three: ["three"] } } } },
  server: { port: 5173, host: "127.0.0.1" },
}));
