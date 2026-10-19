import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { mockApi } from "./mock-api";

// MOCK=1 answers the API from mock-api.ts instead of the backend (dev server only).
export default defineConfig({
  plugins: [react(), ...(process.env.MOCK ? [mockApi()] : [])],
  server: { port: 5175, proxy: { "/api": "http://127.0.0.1:8000" } },
  build: { target: "es2022", outDir: "dist", emptyOutDir: true },
});
