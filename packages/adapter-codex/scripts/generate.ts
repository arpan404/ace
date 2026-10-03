import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { findExecutable } from "@ace/provider-kit/discovery";
import { probe } from "@ace/provider-kit/process";

// Keep only the dependency closure used by this adapter. No protocol is handwritten.
const roots = [
  "InitializeParams",
  "InitializeResponse",
  "v2/ThreadItem",
  "v2/ThreadStartParams",
  "v2/ThreadResumeParams",
  "v2/TurnStartParams",
  "v2/TurnSteerParams",
  "v2/TurnInterruptParams",
  "v2/ThreadQueueAddParams",
  "v2/ThreadBackgroundTerminalsListParams",
  "v2/ThreadBackgroundTerminalsTerminateParams",
];
const binary = await findExecutable(process.env["ACE_CODEX_BIN"] ?? "codex");
if (!binary) throw new Error("Install Codex or set ACE_CODEX_BIN");
const scratch = await mkdtemp(resolve(tmpdir(), "ace-codex-protocol-"));
const destination = fileURLToPath(new URL("../src/generated/", import.meta.url));
try {
  const version = await probe(binary, ["--version"]);
  await probe(binary, ["app-server", "generate-ts", "--experimental", "--out", scratch]);
  await rm(destination, { recursive: true, force: true });
  const copied = new Set<string>();
  async function copy(name: string): Promise<void> {
    if (copied.has(name)) return;
    copied.add(name);
    const path = resolve(scratch, `${name}.ts`);
    let source = await readFile(path, "utf8");
    const imports = [...source.matchAll(/from "([^"]+)"/g)];
    for (const match of imports) {
      const specifier = match[1];
      if (!specifier) continue;
      const dependency = resolve(dirname(path), specifier).slice(scratch.length + 1);
      await copy(dependency);
    }
    source = source.replace(/from "([^"]+)"/g, 'from "$1.ts"');
    const output = resolve(destination, `${name}.ts`);
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, source);
  }
  for (const root of roots) await copy(root);
  await writeFile(resolve(destination, "VERSION"), `${version}\n`);
  const formatter = fileURLToPath(new URL("../../../node_modules/.bin/oxfmt", import.meta.url));
  await probe(formatter, [destination]);
} finally {
  await rm(scratch, { recursive: true, force: true });
}
