import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  build: { outDir: "../internal/web/dist", emptyOutDir: true },
  server: {
    port: 8098,
    strictPort: true,
    host: "0.0.0.0",
    proxy: { "/api": "http://localhost:8081", "/healthz": "http://localhost:8081" },
  },
});
