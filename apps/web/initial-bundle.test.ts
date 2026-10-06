import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, test } from "vitest";
import { build, type Plugin } from "vite";
import { initialBundle } from "./initial-bundle.ts";

const entry = join(import.meta.dirname, "src/main.tsx");
const popup = join(import.meta.dirname, "src/features/shell/menu-button-popup.tsx");

function compile(source: string) {
  const fixture: Plugin = {
    name: "page-fixture",
    load(id) {
      if (id === entry) return source;
      if (id === popup) return "export const action = () => 'menu opened';";
      return null;
    },
  };
  return build({
    configFile: false,
    logLevel: "silent",
    plugins: [fixture, initialBundle()],
    build: { write: false, lib: { entry, formats: ["es"] } },
  });
}

test("making a closed popup eager fails the page build with its module name", async () => {
  await expect(compile(`export { action } from ${JSON.stringify(popup)};`)).rejects.toThrow(
    "Forbidden initial page module: src/features/shell/menu-button-popup.tsx",
  );
});

test("a deferred popup can still be loaded and used without entering the initial graph", async () => {
  const result = await compile(`export const load = () => import(${JSON.stringify(popup)});`);
  const outputs = (Array.isArray(result) ? result : [result]).flatMap((built) => built.output);
  const out = mkdtempSync(join(tmpdir(), "ace-page-guard-"));
  try {
    for (const chunk of outputs)
      if (chunk.type === "chunk") writeFileSync(join(out, chunk.fileName), chunk.code);
    const start = outputs.find((chunk) => chunk.type === "chunk" && chunk.isEntry);
    if (!start) throw new Error("Page entry was not emitted");
    const reply = execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        "const { load } = await import(process.argv[1]); process.stdout.write((await load()).action());",
        pathToFileURL(join(out, start.fileName)).href,
      ],
      { encoding: "utf8" },
    );
    expect(reply).toBe("menu opened");
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});
