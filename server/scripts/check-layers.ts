/**
 * Checks that imports point one way, so each layer can be read without the ones above it:
 *
 *   api → jobs → domain → integrations → data → core → utils, clock, config → types
 *
 * main.ts and server.ts wire it all together and may import anything. Also fails on dynamic import() (a way
 * around the rule), on import cycles, and on SQL outside src/data. `import type` is ignored: it's gone at runtime.
 *
 * npm run check:layers
 */

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "src");

const ORDER = ["types", "base", "core", "data", "integrations", "domain", "jobs", "api", "app"] as const;
type Layer = (typeof ORDER)[number];

function layerOf(file: string): Layer {
  const top = file.split("/")[0];
  if (["main.ts", "server.ts"].includes(file)) return "app";
  if (["clock.ts", "config.ts"].includes(file) || top === "utils") return "base";
  if ((ORDER as readonly string[]).includes(top)) return top as Layer;
  throw new Error(`${file}: not in any layer; add it to scripts/check-layers.ts`);
}

const files = (readdirSync(SRC, { recursive: true }) as string[]).filter((f) => f.endsWith(".ts")).map((f) => f.split("\\").join("/"));
const problems: string[] = [];
const graph = new Map<string, string[]>();

for (const file of files) {
  const text = readFileSync(join(SRC, file), "utf8");
  const deps: string[] = [];
  for (const m of text.matchAll(/^import\s+(type\s+)?[^;]*?from\s+"(\.[^"]+)\.js";/gms)) {
    if (m[1]) continue;
    const dep = normalize(join(dirname(file), m[2])).split("\\").join("/") + ".ts";
    deps.push(dep);
    const from = layerOf(file), to = layerOf(dep);
    if (from !== "app" && ORDER.indexOf(to) > ORDER.indexOf(from)) problems.push(`${file} (${from}) imports ${dep} (${to}): ${to} is above ${from}`);
  }
  if (/\bawait import\(|\bimport\(\s*["']/.test(text)) problems.push(`${file}: dynamic import(); import it at the top`);
  if (layerOf(file) !== "data" && /\.execute(<[^>]*>)?\(|\bconn\.db\b|\bselectFrom\(/.test(text)) problems.push(`${file}: SQL outside src/data; add a function to a repo`);
  graph.set(file, deps);
}

// Cycles, by depth-first search over value imports.
const state = new Map<string, "open" | "done">();
const stack: string[] = [];
function visit(f: string) {
  state.set(f, "open"); stack.push(f);
  for (const d of graph.get(f) ?? []) {
    if (state.get(d) === "open") problems.push(`import cycle: ${[...stack.slice(stack.indexOf(d)), d].join(" → ")}`);
    else if (!state.has(d)) visit(d);
  }
  stack.pop(); state.set(f, "done");
}
for (const f of graph.keys()) if (!state.has(f)) visit(f);

if (problems.length) {
  console.error(`Layer check failed (${problems.length}):\n${problems.map((p) => `  - ${p}`).join("\n")}`);
  process.exit(1);
}
console.log(`Layers OK: ${files.length} modules, imports point one way.`);
