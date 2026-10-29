import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { mockApi } from "./mock-api";

// MOCK=1 answers the API from mock-api.ts instead of the backend (dev server only); API= points at a server on another port.
export default defineConfig({
  plugins: [react(), ...(process.env.MOCK ? [mockApi()] : [])],
  server: { port: 5175, proxy: { "/api": process.env.API ?? "http://127.0.0.1:8000" } },
  build: { target: "es2022", outDir: "dist", emptyOutDir: true },
});
