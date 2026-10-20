/**
 * Checks how the code is put together, so each feature can be read and changed on its own:
 *
 *   src/modules/<feature>/   one feature: routes.ts, service.ts, repo.ts and whatever else it needs
 *   src/shared/              what every feature uses: db, the clock, the pay calendar, categories, the ledger, http, utils
 *   config, types            the base everything stands on
 *   main, server, scheduler, contract   the app: wires features together
 *
 * Rules:
 *  - The base imports only the base; shared imports only shared and the base, never a feature.
 *  - Only the app imports a routes.ts: routes are where a feature meets HTTP, not something to build on.
 *  - Repositories (repo.ts, *_repo.ts) import only shared and the base, and they hold the SQL: SQL anywhere
 *    else (outside shared/db.ts and shared/ledger/) fails.
 *  - Features may use each other, but never in a circle (routes aside, which only wire). Something two features
 *    both need goes in the one lower down, or in shared.
 *  - schemas.ts (what a feature's routes return, in Zod) uses only other schemas and shared; converters.ts (rows to
 *    those shapes) is pure: no database, no repositories, no services.
 *  - No import cycles between files, and no dynamic import() (a way around all of the above).
 *
 * `import type` is ignored: it's gone at runtime. npm run check:structure
 */

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "src");

type Kind = "base" | "shared" | "module" | "app";

const kindOf = (f: string): Kind =>
  ["main.ts", "server.ts", "scheduler.ts", "contract.ts"].includes(f) ? "app"
  : f.startsWith("shared/") ? "shared"
  : f.startsWith("modules/") ? "module"
  : f === "config.ts" || f.startsWith("types/") ? "base"
  : (() => { throw new Error(`${f}: not a module, shared or base file; add it to scripts/check-structure.ts`); })();

const featureOf = (f: string) => (f.startsWith("modules/") ? f.split("/")[1] : null);
const isRoutes = (f: string) => f.startsWith("modules/") && f.endsWith("/routes.ts");
const isRepo = (f: string) => /(^|\/|_)repo\.ts$/.test(f);
const isSchemas = (f: string) => f.startsWith("modules/") && f.endsWith("/schemas.ts");
const isConverters = (f: string) => f.startsWith("modules/") && f.endsWith("/converters.ts");
const mayHoldSql = (f: string) => isRepo(f) || f === "shared/db.ts" || f.startsWith("shared/ledger/");

const files = (readdirSync(SRC, { recursive: true }) as string[]).filter((f) => f.endsWith(".ts")).map((f) => f.split("\\").join("/"));
const problems: string[] = [];
const fileGraph = new Map<string, string[]>();
const featureGraph = new Map<string, Map<string, string>>();  // feature → feature → one file that shows it

for (const file of files) {
  const text = readFileSync(join(SRC, file), "utf8");
  const kind = kindOf(file), feature = featureOf(file);
  const deps: string[] = [];
  for (const m of text.matchAll(/^import\s+(type\s+)?[^;]*?from\s+"(\.[^"]+)\.js";/gms)) {
    if (m[1]) continue;
    const dep = normalize(join(dirname(file), m[2])).split("\\").join("/") + ".ts";
    deps.push(dep);
    const depKind = kindOf(dep), depFeature = featureOf(dep);
    if (kind === "base" && depKind !== "base") problems.push(`${file} (base) imports ${dep}: the base stands on nothing`);
    if (kind === "shared" && depKind !== "shared" && depKind !== "base") problems.push(`${file} (shared) imports ${dep}: shared never uses a feature or the app`);
    if (kind !== "app" && depKind === "app") problems.push(`${file} imports ${dep}: only the app wires itself`);
    if (isRoutes(dep) && kind !== "app") problems.push(`${file} imports ${dep}: only the app imports routes`);
    if (isRepo(file) && (depKind === "module" || depKind === "app")) problems.push(`${file} (a repository) imports ${dep}: repositories use only shared and the base`);
    if (isSchemas(file) && !(isSchemas(dep) || depKind === "shared" || depKind === "base")) problems.push(`${file} imports ${dep}: schemas describe shapes, they use only other schemas and shared`);
    if (isConverters(file) && (isRepo(dep) || dep === "shared/db.ts" || dep.startsWith("shared/ledger/") || (depKind === "module" && !isSchemas(dep) && !isConverters(dep)))) {
      problems.push(`${file} imports ${dep}: converters are pure, they take what was read and use only schemas, other converters and shared helpers`);
    }
    // A schema built from another feature's shapes isn't a dependency between the features' code.
    if (feature && depFeature && depFeature !== feature && !isRoutes(file) && !(isSchemas(file) && isSchemas(dep))) {
      if (!featureGraph.has(feature)) featureGraph.set(feature, new Map());
      featureGraph.get(feature)!.set(depFeature, `${file} → ${dep}`);
    }
  }
  if (/\bawait import\(|\bimport\(\s*["']/.test(text)) problems.push(`${file}: dynamic import(); import it at the top`);
  if (!mayHoldSql(file) && /\.execute(<[^>]*>)?\(|\bconn\.db\b|\bselectFrom\(/.test(text)) problems.push(`${file}: SQL outside a repository; add a function to one`);
  fileGraph.set(file, deps);
}

/** Every cycle depth-first search runs into, as a path. */
function cycles(graph: Map<string, Iterable<string>>): string[][] {
  const state = new Map<string, "open" | "done">(), stack: string[] = [], found: string[][] = [];
  const visit = (v: string) => {
    state.set(v, "open"); stack.push(v);
    for (const w of graph.get(v) ?? []) {
      if (state.get(w) === "open") found.push([...stack.slice(stack.indexOf(w)), w]);
      else if (!state.has(w)) visit(w);
    }
    stack.pop(); state.set(v, "done");
  };
  for (const v of graph.keys()) if (!state.has(v)) visit(v);
  return found;
}

for (const c of cycles(fileGraph)) problems.push(`import cycle: ${c.join(" → ")}`);
const features = new Map([...featureGraph].map(([k, v]) => [k, v.keys()] as const));
for (const c of cycles(features)) {
  const via = c.slice(1).map((to, i) => featureGraph.get(c[i])!.get(to)).join("; ");
  problems.push(`features in a circle: ${c.join(" → ")} (${via})`);
}

if (problems.length) {
  console.error(`Structure check failed (${problems.length}):\n${problems.map((p) => `  - ${p}`).join("\n")}`);
  process.exit(1);
}
const count = new Set(files.map(featureOf).filter(Boolean)).size;
console.log(`Structure OK: ${files.length} files, ${count} features, no circles.`);
