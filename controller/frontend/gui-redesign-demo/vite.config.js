import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const demoRoot = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: demoRoot,
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: 8098,
    strictPort: true,
    fs: {
      allow: [resolve(demoRoot, "..")],
    },
    proxy: {
      "/api": "http://127.0.0.1:8081",
      "/healthz": "http://127.0.0.1:8081",
    },
  },
});
