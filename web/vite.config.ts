import { defineConfig } from "vite";
export default defineConfig({
  base: "./",
  build: { target: "es2022", assetsInlineLimit: 0, sourcemap: false,
           rollupOptions: { output: { manualChunks: { three: ["three"] } } } },
  server: { port: 5173, host: "127.0.0.1" },
});
