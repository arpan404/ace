// Temporary: per-step costs of reading many small files on Windows. Removed before finishing.
import { mkdtemp, open, readFile, rm, writeFile } from "node:fs/promises";
import { constants, closeSync, fstatSync, readSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { openAt, openMetadataAt, openRoot, statWindowsFd } from "../src/descriptor.ts";
import { createWorkspace } from "../src/index.ts";

const root = await mkdtemp(join(tmpdir(), "ace-steps-"));
const count = 2000;
await Promise.all(
  Array.from({ length: count }, (_, i) => writeFile(join(root, `f${i}.ts`), "export {};\n")),
);
const names = Array.from({ length: count }, (_, i) => `f${i}.ts`);
const dir = openRoot(root);
const time = async (label: string, step: (name: string) => unknown) => {
  const start = performance.now();
  for (const name of names) await step(name);
  const ms = performance.now() - start;
  console.log(JSON.stringify({ step: label, perFileUs: Math.round((ms * 1000) / count) }));
};
await time("openMetadataAt+close", (n) => closeSync(openMetadataAt(dir.fd, n).fd));
await time("openAt+close", (n) => closeSync(openAt(dir.fd, n, constants.O_RDONLY).fd));
await time("openAt+statWindowsFd+close", (n) => {
  const d = openAt(dir.fd, n, constants.O_RDONLY);
  statWindowsFd(d.fd);
  closeSync(d.fd);
});
await time("openAt+fstatSync+readSync+close", (n) => {
  const d = openAt(dir.fd, n, constants.O_RDONLY);
  fstatSync(d.fd);
  readSync(d.fd, Buffer.alloc(64), 0, 64, 0);
  closeSync(d.fd);
});
await time("openAt+async read+async close", async (n) => {
  const d = openAt(dir.fd, n, constants.O_RDONLY);
  await d.read(Buffer.alloc(64), 0, 64, 0);
  await d.close();
});
await time("node open+read+close (async)", async (n) => {
  const h = await open(join(root, n), "r");
  await h.read(Buffer.alloc(64), 0, 64, 0);
  await h.close();
});
await time("node readFile (async)", (n) => readFile(join(root, n)));
await dir.close();
const service = await createWorkspace(root, { ripgrep: null });
for (let i = 0; i < 2; i++) {
  const start = performance.now();
  await service.search({ query: "needle", limit: 10 });
  console.log(
    JSON.stringify({
      step: "workspace search",
      perFileUs: Math.round(((performance.now() - start) * 1000) / count),
    }),
  );
}
const listing = performance.now();
await service.list({ dir: "", depth: 1, limit: 1000 });
console.log(
  JSON.stringify({
    step: "list 1000",
    perFileUs: Math.round(((performance.now() - listing) * 1000) / 1000),
  }),
);
await rm(root, { recursive: true, force: true });
