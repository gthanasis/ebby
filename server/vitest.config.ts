import { defineConfig } from "vitest/config";

// One process, one file at a time: the tests share a real Postgres database (row-level security is what they check).
export default defineConfig({
  test: { include: ["test/**/*.test.ts"], fileParallelism: false, isolate: false, setupFiles: ["test/env.ts"], testTimeout: 30_000, hookTimeout: 60_000 },
});
