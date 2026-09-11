import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const __dirname = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: "../internal/web/dist",
    emptyOutDir: true,
    rollupOptions: {
      input: {
        main: resolve(__dirname, "index.html"),
        competition: resolve(__dirname, "competition.html"),
      },
    },
  },
  server: {
    port: 8098,
    strictPort: true,
    host: "0.0.0.0",
    proxy: { "/api": "http://localhost:8081", "/healthz": "http://localhost:8081" },
  },
});
