import { join } from "node:path";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";
import { expect, test } from "vitest";
import { build, type Plugin } from "vite";
import { workerBundle } from "./worker-bundle.ts";

const entry = join(import.meta.dirname, "src/boot/client-worker.ts");
const service = join(import.meta.dirname, "../../packages/protocol/src/history.ts");

function compile(source: string) {
  const fixture: Plugin = {
    name: "worker-fixture",
    load(id) {
      if (id === entry) return source;
      if (id === service) return "export const reply = () => 'history';";
      return null;
    },
  };
  return build({
    configFile: false,
    logLevel: "silent",
    plugins: [fixture, workerBundle()],
    build: {
      write: false,
      lib: { entry, formats: ["es"] },
    },
  });
}

test("a cold service accidentally made eager fails the build with its module name", async () => {
  await expect(compile(`export { reply } from ${JSON.stringify(service)};`)).rejects.toThrow(
    "Forbidden eager client worker module: ../../packages/protocol/src/history.ts",
  );
});

test("a cold service stays available through a lazy import without failing the startup guard", async () => {
  const result = await compile(`export const load = () => import(${JSON.stringify(service)});`);
  const outputs = (Array.isArray(result) ? result : [result]).flatMap(
    (buildResult) => buildResult.output,
  );
  const out = mkdtempSync(join(tmpdir(), "ace-worker-guard-"));
  try {
    for (const chunk of outputs)
      if (chunk.type === "chunk") writeFileSync(join(out, chunk.fileName), chunk.code);
    const start = outputs.find((chunk) => chunk.type === "chunk" && chunk.isEntry);
    if (!start) throw new Error("Worker entry was not emitted");
    const reply = execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        "const { load } = await import(process.argv[1]); process.stdout.write((await load()).reply());",
        pathToFileURL(join(out, start.fileName)).href,
      ],
      { encoding: "utf8" },
    );
    expect(reply).toBe("history");
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});
