import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { z } from "zod";
import { budgets } from "./budgets.ts";

/*
 * Bundle budgets per route (ADR 0056): builds the web app once into a temporary directory and
 * weighs, gzipped, what the first paint needs, what each lazily loaded route adds on top, the
 * CSS and each worker.
 */

const web = new URL("../../../apps/web/", import.meta.url).pathname;
const out = mkdtempSync(join(tmpdir(), "ace-web-bundle-"));
const Manifest = z.record(
  z.string(),
  z.object({
    file: z.string(),
    isEntry: z.boolean().optional(),
    isDynamicEntry: z.boolean().optional(),
    imports: z.array(z.string()).optional(),
    css: z.array(z.string()).optional(),
    src: z.string().optional(),
  }),
);

const kb = (bytes: number) => bytes / 1024;

try {
  execFileSync("bunx", ["vite", "build", "--manifest", "--outDir", out, "--emptyOutDir"], {
    cwd: web,
    stdio: ["ignore", "ignore", "inherit"],
  });
  const manifest = Manifest.parse(
    JSON.parse(readFileSync(join(out, ".vite", "manifest.json"), "utf8")),
  );
  const sizes = new Map<string, number>();
  const gz = (file: string) => {
    let size = sizes.get(file);
    if (size === undefined) {
      size = gzipSync(readFileSync(join(out, file)), { level: 9 }).length;
      sizes.set(file, size);
    }
    return size;
  };
  /** Files a chunk loads before it runs: itself, its static imports and their CSS. */
  const closure = (key: string, into = new Set<string>()) => {
    const chunk = manifest[key];
    if (!chunk || into.has(chunk.file)) return into;
    into.add(chunk.file);
    for (const css of chunk.css ?? []) into.add(css);
    for (const imported of chunk.imports ?? []) closure(imported, into);
    return into;
  };
  const weigh = (files: Iterable<string>) =>
    kb([...files].reduce((sum, file) => sum + gz(file), 0));
  const entry = Object.keys(manifest).find((key) => manifest[key]?.isEntry);
  if (!entry) throw new Error("No entry chunk in the manifest");
  const initial = closure(entry);
  const initialJs = weigh([...initial].filter((file) => file.endsWith(".js")));
  const css = weigh([...initial].filter((file) => file.endsWith(".css")));
  const failures: string[] = [];
  const report = (label: string, size: number, limit: number) => {
    const line = `${label.padEnd(56)} ${size.toFixed(1).padStart(7)} KB  (≤ ${limit})`;
    process.stdout.write(`${size > limit ? "✗" : " "} ${line}\n`);
    if (size > limit) failures.push(line);
  };
  report("initial JS (entry and its static imports)", initialJs, budgets.bundle.initialKb);
  report("CSS", css, budgets.bundle.cssKb);
  const routes = Object.entries(manifest)
    .filter(([, chunk]) => chunk.isDynamicEntry && chunk.src?.includes("/routes/"))
    .map(([key, chunk]) => {
      const own = [...closure(key)].filter((file) => !initial.has(file) && file.endsWith(".js"));
      return { name: chunk.src ?? key, size: weigh(own) };
    })
    .toSorted((a, b) => b.size - a.size);
  const heaviest = routes[0];
  if (heaviest)
    report(
      `first screen (shell + ${heaviest.name.replace(/^src\/routes\//, "").replace(/\?.*$/, "")})`,
      initialJs + heaviest.size,
      budgets.bundle.firstScreenKb,
    );
  for (const route of routes.slice(0, 8))
    report(`route ${route.name.replace(/^src\/routes\//, "")}`, route.size, budgets.bundle.routeKb);
  for (const route of routes.slice(8))
    if (route.size > budgets.bundle.routeKb)
      report(`route ${route.name}`, route.size, budgets.bundle.routeKb);
  const assets = readdirSync(join(out, "assets"));
  // Workers are bundled apart from the page and are not in its manifest: follow each entry's
  // own imports. What it imports statically loads before it runs; what it imports dynamically
  // loads later and is weighed as well, so splitting a worker never hides bytes.
  const imports = (file: string) => {
    const code = readFileSync(join(out, "assets", file), "utf8");
    const found = (pattern: RegExp) =>
      [...code.matchAll(pattern)].flatMap((match) => (match[1] ? [match[1]] : []));
    return {
      eager: found(/(?:\bfrom|\bimport)\s*"\.\/([^"]+\.js)"/g),
      lazy: found(/\bimport\(\s*"\.\/([^"]+\.js)"\s*\)/g),
    };
  };
  const workerClosure = (entry: string, into = new Set<string>()) => {
    if (into.has(entry)) return into;
    into.add(entry);
    for (const file of imports(entry).eager) workerClosure(file, into);
    return into;
  };
  for (const entry of assets.filter((name) => /worker/.test(name) && name.endsWith(".js"))) {
    const label = `worker ${entry.replace(/-[\w-]{8}\.js$/, "")}`;
    const eager = workerClosure(entry);
    const weighOf = (files: Iterable<string>) =>
      weigh([...files].map((file) => join("assets", file)));
    report(label, weighOf(eager), budgets.bundle.workerKb);
    const lazy = new Set<string>();
    const queue = [...eager];
    for (const file of queue)
      for (const next of imports(file).lazy)
        for (const chunk of workerClosure(next))
          if (!eager.has(chunk) && !lazy.has(chunk)) {
            lazy.add(chunk);
            queue.push(chunk);
          }
    if (lazy.size)
      report(
        `${label} with its lazy chunks`,
        weighOf([...eager, ...lazy]),
        budgets.bundle.workerTotalKb,
      );
  }
  if (failures.length) {
    process.stderr.write(`bundle budgets exceeded:\n${failures.join("\n")}\n`);
    process.exitCode = 1;
  }
} finally {
  rmSync(out, { recursive: true, force: true });
}
